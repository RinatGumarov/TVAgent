/**
 * TVAgent — background worker.
 *
 * Holds the API key and is the only context that talks to a model provider.
 * The panel streams a turn over a Port and gets back the assembled assistant
 * message. Anthropic is the native path; every other provider speaks the
 * OpenAI chat-completions shape and is normalized into Anthropic content
 * blocks on the way in.
 */

importScripts(
  '/src/shared/models.js',
  '/src/shared/credentials.js',
  '/src/shared/provider-url.js'
);

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULTS = {
  provider: 'anthropic',
  model: TVAgentModels.DEFAULT_MODEL,
  baseUrl: 'http://localhost:11434/v1',
  effort: 'high',
};

/** Not configurable. */
const MAX_TOKENS = 32000;

/**
 * The active provider's own key and model; each provider has its own storage
 * slot.
 */
async function settings() {
  const s = await chrome.storage.local.get([
    'apiKey', 'model', 'effort', 'provider', 'baseUrl', 'openaiApiKey', 'openaiModel',
    'dataDisclosureAccepted',
  ]);
  const provider = s.provider || DEFAULTS.provider;
  const common = {
    provider,
    baseUrl: (s.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    effort: s.effort || DEFAULTS.effort,
    maxTokens: MAX_TOKENS,
    dataDisclosureAccepted: !!s.dataDisclosureAccepted,
  };

  const slots = TVAgentCredentials.split(s);

  if (provider === 'anthropic') {
    return { ...common, apiKey: slots.apiKey, model: slots.model || DEFAULTS.model };
  }
  try {
    const parsed = TVAgentProviderURL.parse(common.baseUrl);
    common.baseUrl = parsed.baseUrl;
    common.providerPermission = parsed.permission;
  } catch (err) {
    common.baseUrlError = err.message || String(err);
  }
  return { ...common, apiKey: slots.openaiApiKey, model: slots.openaiModel };
}

/** What has to be in place before a turn can go out, in the user's terms. */
function configError(cfg, { requireModel = true } = {}) {
  if (cfg.provider === 'anthropic') {
    return cfg.apiKey
      ? null
      : 'No API key set. Open the panel settings and add your Anthropic API key.';
  }
  // Local providers authenticate with nothing at all, so a key is never
  // required here — but nothing can be called without a model and a URL.
  if (!cfg.baseUrl) return 'No base URL set. Open the panel settings and point it at your provider.';
  if (cfg.baseUrlError) return cfg.baseUrlError;
  try {
    TVAgentProviderURL.parse(cfg.baseUrl);
  } catch (err) {
    return err.message || String(err);
  }
  if (requireModel && !cfg.model) {
    return 'No model set. Open the panel settings and enter the model your provider serves.';
  }
  return null;
}

/** The final worker-side gate before credentials or chart data reach fetch(). */
async function networkAccessError(cfg, options) {
  if (!cfg.dataDisclosureAccepted) {
    return 'Accept the data disclosure in panel settings before contacting a model provider.';
  }
  const problem = configError(cfg, options);
  if (problem) return problem;
  if (cfg.provider !== 'openai') return null;

  const granted = await chrome.permissions.contains({ origins: [cfg.providerPermission] });
  return granted
    ? null
    : 'Allow access to the configured model provider in panel settings before sending chart data.';
}

/** Validates content-script requests before invoking the privileged permissions API. */
async function providerPermission(baseUrl, action) {
  const parsed = TVAgentProviderURL.parse(baseUrl);
  const query = { origins: [parsed.permission] };
  if (action === 'contains') {
    return { granted: await chrome.permissions.contains(query), permission: parsed.permission };
  }
  if (action === 'request') {
    return { granted: await chrome.permissions.request(query), permission: parsed.permission };
  }
  if (action === 'remove') {
    return { removed: await chrome.permissions.remove(query), permission: parsed.permission };
  }
  throw new Error('Unknown provider-permission action.');
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'provider-permission') {
    (async () => {
      try {
        sendResponse(await providerPermission(msg.baseUrl, msg.action));
      } catch (err) {
        sendResponse({ error: err.message || String(err) });
      }
    })();
    return true;
  }
  if (msg?.type !== 'list-models') return undefined;
  (async () => {
    try {
      const cfg = await settings();
      const problem = await networkAccessError(cfg, { requireModel: false });
      if (problem) throw new Error(problem);
      sendResponse({ models: await listModels(cfg) });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true; // the reply comes later
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tvagent-llm') return;

  let aborter = null;
  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
    aborter?.abort();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'run') return;

    // Allocated before the first await, so a disconnect during the storage
    // read still aborts the turn.
    aborter = new AbortController();
    if (closed) return;

    const cfg = await settings();
    if (closed) return;

    const problem = await networkAccessError(cfg);
    if (problem) {
      port.postMessage({ type: 'error', error: problem });
      return;
    }

    try {
      const message = cfg.provider === 'anthropic'
        ? await streamAnthropic(cfg, msg, port, aborter.signal)
        : await streamOpenAI(cfg, msg, port, aborter.signal);
      port.postMessage({ type: 'done', message });
    } catch (err) {
      if (err.name === 'AbortError') return;
      port.postMessage({ type: 'error', error: err.message || String(err) });
    }
  });
});

/** Turns a non-2xx response into an error carrying whatever detail the server gave. */
async function httpError(response, label) {
  let detail = '';
  try {
    const data = await response.json();
    detail = data?.error?.message || JSON.stringify(data);
  } catch (_) {
    detail = await response.text().catch(() => '');
  }
  return new Error(`${label} ${response.status}: ${detail || response.statusText}`);
}

/**
 * Splits an SSE body into `data:` payloads. Both providers use the same framing;
 * only the event shapes inside differ.
 */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { yield JSON.parse(payload); } catch (_) { /* keep-alive or partial */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function streamAnthropic(cfg, req, port, signal) {
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    stream: true,
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    // The catalog says which reasoning fields each model accepts.
    ...TVAgentModels.reasoning(cfg.model, { effort: cfg.effort, maxTokens: cfg.maxTokens }),
  };

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct browser-context calls.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await httpError(response, 'Anthropic API');
  return parseAnthropicStream(response, port);
}

/**
 * Reassembles the SSE stream into a complete assistant message. Content blocks
 * are echoed back to the model verbatim on the next turn, so thinking blocks
 * keep their signatures.
 */
async function parseAnthropicStream(response, port) {
  const blocks = [];
  const partialJson = new Map(); // block index → accumulated tool input JSON
  let stopReason = null;

  for await (const event of sseEvents(response)) {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        blocks[event.index] = structuredClone(block);
        if (block.type === 'tool_use') partialJson.set(event.index, '');
        if (block.type === 'thinking') blocks[event.index].thinking = block.thinking || '';
        if (block.type === 'text') blocks[event.index].text = block.text || '';
        port.postMessage({ type: 'block_start', blockType: block.type, name: block.name });
        break;
      }

      case 'content_block_delta': {
        const d = event.delta;
        const block = blocks[event.index];
        if (!block) break;

        if (d.type === 'text_delta') {
          block.text = (block.text || '') + d.text;
          port.postMessage({ type: 'text', delta: d.text });
        } else if (d.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + d.thinking;
          port.postMessage({ type: 'thinking', delta: d.thinking });
        } else if (d.type === 'signature_delta') {
          block.signature = (block.signature || '') + d.signature;
        } else if (d.type === 'input_json_delta') {
          partialJson.set(event.index, (partialJson.get(event.index) || '') + d.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        const block = blocks[event.index];
        if (block && block.type === 'tool_use') {
          const raw = partialJson.get(event.index) || '';
          try {
            block.input = raw ? JSON.parse(raw) : {};
          } catch (_) {
            block.input = {};
          }
          partialJson.delete(event.index);
        }
        break;
      }

      case 'message_delta':
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        break;

      case 'error':
        throw new Error(event.error?.message || 'Stream error from the API.');
    }
  }

  // The API refuses an empty text block when it is echoed back, and one
  // poisons every later turn.
  return { content: blocks.filter(nonEmpty), stop_reason: stopReason };
}

function nonEmpty(block) {
  if (!block) return false;
  if (block.type === 'text') return !!(block.text && block.text.trim());
  // A thinking block with a signature has to survive even when its summary is
  // blank.
  if (block.type === 'thinking') {
    return !!((block.thinking && block.thinking.trim()) || block.signature);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * The models the configured provider will answer to. `/v1/models` is part of
 * the OpenAI shape, so Ollama, Groq, Gemini and OpenRouter all serve it.
 */
async function listModels(cfg) {
  // Anthropic ships a fixed list in the panel. Asking here would also mean
  // sending its key to whatever base URL happens to be stored.
  if (cfg.provider === 'anthropic') return [];

  const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  let response;
  try {
    response = await fetch(`${cfg.baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Error(`Could not reach ${cfg.baseUrl} — ${err.message}.`);
  }
  if (!response.ok) throw await httpError(response, 'Provider');

  const ids = ((await response.json())?.data || []).map((m) => m.id).filter(Boolean);
  const tools = await toolSupport(cfg, ids);

  // A model that cannot call tools is useless to the agent, but the list may
  // simply be unannotated — so those sink to the bottom instead of vanishing.
  return ids
    .map((id) => ({ id, tools: tools.has(id) ? tools.get(id) : null }))
    .sort((a, b) => (a.tools === false) - (b.tools === false));
}

/**
 * Which models can call tools. Only Ollama answers this, through its own
 * /api/show, so one model is probed first: if that endpoint is not there, the
 * rest are never asked and the list comes back unannotated.
 */
async function toolSupport(cfg, ids) {
  const found = new Map();
  if (!ids.length) return found;

  const root = cfg.baseUrl.replace(/\/v\d+$/, '');
  const ask = async (model) => {
    const r = await fetch(`${root}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error(`api/show ${r.status}`);
    return ((await r.json())?.capabilities || []).includes('tools');
  };

  try {
    found.set(ids[0], await ask(ids[0]));
  } catch (_) {
    return found;
  }

  const rest = ids.slice(1);
  const answers = await Promise.all(rest.map((id) => ask(id).catch(() => null)));
  rest.forEach((id, i) => { if (answers[i] !== null) found.set(id, answers[i]); });
  return found;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (Ollama, Gemini, Groq, OpenRouter, …)
// ---------------------------------------------------------------------------

/**
 * Anthropic messages → OpenAI messages. Tool calls move from the assistant's
 * content array onto `tool_calls`, and each tool_result becomes its own
 * `tool` turn. Thinking blocks are dropped; their signatures mean nothing to
 * another provider.
 */
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content || [];

    if (msg.role === 'user') {
      // A user turn is either plain text or a batch of tool results, never both.
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
        });
      }
      if (text) out.push({ role: 'user', content: text });
      continue;
    }

    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));

    const assistant = { role: 'assistant', content: text };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    out.push(assistant);
  }

  return out;
}

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

const STOP_REASONS = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens' };

async function streamOpenAI(cfg, req, port, signal) {
  const headers = { 'content-type': 'application/json' };
  // Ollama ignores auth entirely; hosted providers need the bearer token.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let response;
  try {
    response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        stream: true,
        messages: toOpenAIMessages(req.system, req.messages),
        tools: toOpenAITools(req.tools),
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // A dead server and a revoked optional host both surface as a
    // bare "Failed to fetch", which tells the user nothing.
    throw new Error(
      `Could not reach ${cfg.baseUrl} — ${err.message}. Check that the provider is running, ` +
      'and grant its exact host from panel settings.'
    );
  }

  if (!response.ok) throw await httpError(response, 'Provider');
  return parseOpenAIStream(response, port);
}

/**
 * Reassembles an OpenAI-shaped stream into Anthropic content blocks. Tool
 * calls arrive as fragments keyed by `index`; when a provider omits it, a
 * fragment belongs to the call its id names, or to the call still being
 * streamed.
 */
async function parseOpenAIStream(response, port) {
  let text = '';
  let thinking = '';
  const calls = new Map(); // call key → { id, name, args }
  let openCall = null; // the key the last fragment belonged to
  let stopReason = null;
  let startedText = false;
  let startedThinking = false;

  for await (const event of sseEvents(response)) {
    if (event.error) throw new Error(event.error.message || 'Stream error from the provider.');

    const choice = event.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta || {};

    // Thinking models expose reasoning under one of two names depending on who
    // implemented the compatibility layer.
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (reasoning) {
      if (!startedThinking) { port.postMessage({ type: 'block_start', blockType: 'thinking' }); startedThinking = true; }
      thinking += reasoning;
      port.postMessage({ type: 'thinking', delta: reasoning });
    }

    if (delta.content) {
      if (!startedText) { port.postMessage({ type: 'block_start', blockType: 'text' }); startedText = true; }
      text += delta.content;
      port.postMessage({ type: 'text', delta: delta.content });
    }

    for (const tc of delta.tool_calls || []) {
      const key =
        tc.index != null ? `#${tc.index}`
        : tc.id ? `id:${tc.id}`
        : openCall ?? '#0';
      openCall = key;

      const known = calls.get(key);
      const call = known || { id: '', name: '', args: '' };
      if (tc.id) call.id = tc.id;
      // Some providers stream the name in pieces; others repeat it whole on
      // every fragment.
      const part = tc.function?.name;
      if (part && call.name !== part) call.name += part;
      if (tc.function?.arguments) call.args += tc.function.arguments;
      calls.set(key, call);

      // Once per call, not once per fragment that happens to carry a name.
      if (!known) port.postMessage({ type: 'block_start', blockType: 'tool_use', name: call.name });
    }

    if (choice.finish_reason) stopReason = STOP_REASONS[choice.finish_reason] || choice.finish_reason;
  }

  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });

  let synthesized = 0;
  for (const call of calls.values()) {
    let input = {};
    try {
      input = call.args ? JSON.parse(call.args) : {};
    } catch (_) {
      // A malformed argument blob would otherwise abort the whole turn. Hand
      // the model an empty object and let the tool's own error come back.
      input = {};
    }
    content.push({
      type: 'tool_use',
      // Some providers omit ids on single-call turns, but the agent loop keys
      // tool results by id, so synthesize one when it is missing.
      id: call.id || `call_${synthesized++}`,
      name: call.name,
      input,
    });
  }

  // Providers are inconsistent about finish_reason when a turn ends in tool
  // calls; the presence of calls is the reliable signal.
  if (calls.size > 0) stopReason = 'tool_use';

  return { content, stop_reason: stopReason || 'end_turn' };
}
