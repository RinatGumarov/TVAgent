/**
 * TVAgent — chat panel UI.
 *
 * A right-hand panel with the prompt box, the execution trace, confirmation
 * dialogs and a settings drawer.
 */
(() => {
  'use strict';

  if (window.__tvAgentPanelLoaded) return;
  window.__tvAgentPanelLoaded = true;

  const SUGGESTIONS = [
    'What am I looking at?',
    'Add EMA 50 and EMA 200',
    'Mark the high and low of the visible range',
    'Build an EMA 50/200 crossover strategy and backtest it',
  ];

  let root, messagesEl, inputEl, sendBtn, stopBtn, dotEl, statusEl, settingsEl;
  let agent = null;
  let capabilities = null;
  let currentAssistantEl = null;
  let currentThinkingEl = null;
  let loadModels = () => {}; // wired up with the settings drawer
  const toolEls = new Map();

  // ---------------------------------------------------------------- utils

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  /** Deliberately minimal: fenced blocks and inline code, nothing else. */
  function renderText(text) {
    const parts = String(text).split(/```/);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const body = part.replace(/^[a-zA-Z0-9_-]*\n/, '');
          return `<pre><code>${esc(body)}</code></pre>`;
        }
        return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>');
      })
      .join('');
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addEl(className, html) {
    const el = document.createElement('div');
    el.className = className;
    if (html != null) el.innerHTML = html;
    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  function setStatus(kind, text) {
    dotEl.className = 'tva-dot ' + kind;
    statusEl.textContent = text;
    statusEl.title = text;
  }

  // ---------------------------------------------------------------- markup

  function build() {
    root = document.createElement('div');
    root.id = 'tva-root';
    root.innerHTML = `
      <div class="tva-resizer"></div>
      <div class="tva-header">
        <span class="tva-dot"></span>
        <span class="tva-title">TVAgent</span>
        <span class="tva-composer-hint" id="tva-status"></span>
        <span class="tva-spacer"></span>
        <button class="tva-iconbtn" id="tva-gear" title="Settings">&#9881;</button>
        <button class="tva-iconbtn" id="tva-clear" title="Clear conversation">&#10227;</button>
        <button class="tva-iconbtn" id="tva-close" title="Hide panel">&#10005;</button>
      </div>

      <div class="tva-settings tva-hidden" id="tva-settings">
        <div class="tva-field">
          <label class="tva-label" for="tva-provider">Provider</label>
          <select id="tva-provider">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI-compatible (Ollama, Gemini, Groq…)</option>
          </select>
        </div>
        <div class="tva-field" data-for="anthropic">
          <label class="tva-label" for="tva-key">Anthropic API key</label>
          <input type="password" id="tva-key" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
          <div class="tva-hint">Stored in this extension only. Never sent to the page or to TradingView.</div>
        </div>
        <div class="tva-field" data-for="openai">
          <label class="tva-label" for="tva-base">Base URL</label>
          <input type="text" id="tva-base" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false">
          <div class="tva-hint">Ollama needs no key. For a hosted provider, put its token in the key field below.</div>
        </div>
        <div class="tva-field" data-for="openai">
          <label class="tva-label" for="tva-key2">API key (optional)</label>
          <input type="password" id="tva-key2" placeholder="leave empty for Ollama" autocomplete="off" spellcheck="false">
        </div>
        <div class="tva-field" data-for="anthropic">
          <label class="tva-label" for="tva-model">Model</label>
          <select id="tva-model">
            <option value="claude-opus-5">Claude Opus 5</option>
            <option value="claude-sonnet-5">Claude Sonnet 5</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
          </select>
        </div>
        <div class="tva-field" data-for="openai">
          <label class="tva-label" for="tva-model2">Model</label>
          <input type="text" id="tva-model2" list="tva-models" placeholder="gemma4:26b-a4b-it-qat" autocomplete="off" spellcheck="false">
          <datalist id="tva-models"></datalist>
          <div class="tva-hint" id="tva-model-hint">Must be a model with tool support.</div>
        </div>
        <div class="tva-field" data-for="anthropic">
          <label class="tva-label" for="tva-effort">Effort</label>
          <select id="tva-effort">
            <option value="low">low — fastest</option>
            <option value="medium">medium</option>
            <option value="high">high — default</option>
            <option value="xhigh">xhigh — hardest tasks</option>
          </select>
        </div>
        <div class="tva-field">
          <label class="tva-check">
            <input type="checkbox" id="tva-auto">
            <span>Auto-approve Pine edits (skip confirmations)</span>
          </label>
        </div>
      </div>

      <div class="tva-messages" id="tva-messages"></div>

      <div class="tva-composer">
        <div class="tva-suggestions" id="tva-suggestions"></div>
        <textarea id="tva-input" rows="2" placeholder="Ask about the chart, or tell it what to do..."></textarea>
        <div class="tva-composer-row">
          <span class="tva-composer-hint">Enter to send · Shift+Enter for a new line</span>
          <button class="tva-btn" id="tva-stop" style="display:none">Stop</button>
          <button class="tva-btn primary" id="tva-send">Send</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    messagesEl = root.querySelector('#tva-messages');
    inputEl = root.querySelector('#tva-input');
    sendBtn = root.querySelector('#tva-send');
    stopBtn = root.querySelector('#tva-stop');
    dotEl = root.querySelector('.tva-dot');
    statusEl = root.querySelector('#tva-status');
    settingsEl = root.querySelector('#tva-settings');

    const sugEl = root.querySelector('#tva-suggestions');
    SUGGESTIONS.forEach((s) => {
      const chip = document.createElement('button');
      chip.className = 'tva-chip';
      chip.textContent = s;
      chip.addEventListener('click', () => { inputEl.value = s; inputEl.focus(); });
      sugEl.appendChild(chip);
    });

    root.querySelector('#tva-gear').addEventListener('click', () => {
      settingsEl.classList.toggle('tva-hidden');
      if (!settingsEl.classList.contains('tva-hidden')) loadModels();
    });
    root.querySelector('#tva-close').addEventListener('click', () => root.classList.add('tva-hidden'));
    root.querySelector('#tva-clear').addEventListener('click', () => {
      agent?.reset();
      messagesEl.innerHTML = '';
      greet();
    });

    sendBtn.addEventListener('click', submit);
    stopBtn.addEventListener('click', () => agent?.cancel());
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });

    wireSettings();
    wireResizer();
  }

  function wireSettings() {
    const providerEl = root.querySelector('#tva-provider');
    const keyEl = root.querySelector('#tva-key');
    const key2El = root.querySelector('#tva-key2');
    const baseEl = root.querySelector('#tva-base');
    const modelEl = root.querySelector('#tva-model');
    const model2El = root.querySelector('#tva-model2');
    const effortEl = root.querySelector('#tva-effort');
    const autoEl = root.querySelector('#tva-auto');
    const modelsEl = root.querySelector('#tva-models');
    const hintEl = root.querySelector('#tva-model-hint');

    // Each provider has its own controls; only the active one's are on screen.
    const showFields = () => {
      const p = providerEl.value;
      root.querySelectorAll('.tva-field[data-for]').forEach((el) => {
        el.classList.toggle('tva-hidden', el.dataset.for !== p);
      });
    };

    function migrate(s) {
      const split = s.openaiApiKey !== undefined || s.openaiModel !== undefined;
      if (s.provider !== 'openai' || split) return s;
      const shared = s.apiKey || '';
      const anthropicKey = shared.startsWith('sk-ant-');
      const moved = {
        openaiApiKey: anthropicKey ? '' : shared,
        openaiModel: s.model || '',
        apiKey: anthropicKey ? shared : '',
        model: '',
      };
      chrome.storage.local.set(moved);
      return { ...s, ...moved };
    }

    let listedFor = null;
    loadModels = async () => {
      const url = baseEl.value.trim();
      if (providerEl.value !== 'openai' || !url || listedFor === url) return;
      listedFor = url;

      hintEl.textContent = 'Loading models…';
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({ type: 'list-models' });
      } catch (err) {
        reply = { error: err.message || String(err) };
      }
      if (listedFor !== url) return; // a newer base URL took over

      const models = reply?.models || [];
      modelsEl.innerHTML = '';
      for (const m of models) {
        const option = document.createElement('option');
        option.value = m.id;
        if (m.tools === false) option.label = 'no tool support';
        modelsEl.appendChild(option);
      }

      if (reply?.error) {
        listedFor = null; // so reopening the drawer tries again
        hintEl.textContent = `Could not list models: ${reply.error} Type the name yourself.`;
      } else if (!models.length) {
        hintEl.textContent = 'The provider returned no models. Type the name yourself.';
      } else if (models.some((m) => m.tools !== null)) {
        hintEl.textContent = `${models.length} models — the ones without tool support are marked and listed last.`;
      } else {
        hintEl.textContent = `${models.length} models. It has to be one with tool support.`;
      }
    };

    chrome.storage.local
      .get(['apiKey', 'model', 'effort', 'autoApprove', 'provider', 'baseUrl', 'openaiApiKey', 'openaiModel'])
      .then(migrate)
      .then((s) => {
        providerEl.value = s.provider || 'anthropic';
        // A select goes silently blank when handed a value it has no option for.
        if (!providerEl.value) providerEl.value = 'anthropic';

        keyEl.value = s.apiKey || '';
        key2El.value = s.openaiApiKey || '';
        baseEl.value = s.baseUrl || 'http://localhost:11434/v1';
        modelEl.value = s.model || 'claude-opus-5';
        if (!modelEl.value) modelEl.value = 'claude-opus-5';
        model2El.value = s.openaiModel || '';
        effortEl.value = s.effort || 'high';
        autoEl.checked = !!s.autoApprove;

        showFields();
        // Anthropic cannot run without a key; a local provider can, but it
        // still has to be told which model to call.
        const ready = providerEl.value === 'anthropic' ? s.apiKey : s.openaiModel;
        if (!ready) settingsEl.classList.remove('tva-hidden');
        if (!settingsEl.classList.contains('tva-hidden')) loadModels();
      });

    providerEl.addEventListener('change', () => {
      showFields();
      chrome.storage.local.set({ provider: providerEl.value }).then(loadModels);
    });

    keyEl.addEventListener('change', () => chrome.storage.local.set({ apiKey: keyEl.value.trim() }));
    key2El.addEventListener('change', () => chrome.storage.local.set({ openaiApiKey: key2El.value.trim() }));
    baseEl.addEventListener('change', () => {
      chrome.storage.local.set({ baseUrl: baseEl.value.trim() }).then(loadModels);
    });
    modelEl.addEventListener('change', () => chrome.storage.local.set({ model: modelEl.value }));
    model2El.addEventListener('change', () => chrome.storage.local.set({ openaiModel: model2El.value.trim() }));
    effortEl.addEventListener('change', () => chrome.storage.local.set({ effort: effortEl.value }));
    autoEl.addEventListener('change', () => chrome.storage.local.set({ autoApprove: autoEl.checked }));
  }

  function wireResizer() {
    const handle = root.querySelector('.tva-resizer');
    let dragging = false;

    handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const width = Math.min(Math.max(window.innerWidth - e.clientX, 300), window.innerWidth * 0.7);
      root.style.width = width + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({ panelWidth: parseInt(root.style.width, 10) });
    });

    chrome.storage.local.get('panelWidth').then((s) => {
      if (s.panelWidth) root.style.width = s.panelWidth + 'px';
    });
  }

  // ---------------------------------------------------------------- chat

  function greet() {
    const caps = capabilities || {};
    let text = 'Ask about the chart or tell me what to change. I read and drive TradingView directly.';
    if (caps.symbol) {
      const where = caps.resolution ? `${caps.symbol} · ${caps.resolution}` : caps.symbol;
      text = `Ready on ${where}. ` + text;
    }
    addEl('tva-msg notice', esc(text));
    (caps.warnings || []).forEach((w) => addEl('tva-msg notice', '⚠ ' + esc(w)));
  }

  function submit() {
    const text = inputEl.value.trim();
    if (!text || !agent || agent.busy) return;
    inputEl.value = '';
    addEl('tva-msg user', esc(text));
    startRun();
    agent.send(text);
  }

  function startRun() {
    currentAssistantEl = null;
    currentThinkingEl = null;
    sendBtn.style.display = 'none';
    stopBtn.style.display = '';
    setStatus('warn', 'working…');
  }

  function endRun(status) {
    sendBtn.style.display = '';
    stopBtn.style.display = 'none';
    currentAssistantEl = null;
    currentThinkingEl = null;
    setStatus(status || 'ok', status === 'err' ? 'error' : 'ready');
  }

  function handlers() {
    return {
      autoApprove: () => root.querySelector('#tva-auto').checked,

      onBlockStart(blockType) {
        if (blockType === 'text') currentAssistantEl = null;
        if (blockType === 'thinking') currentThinkingEl = null;
      },

      onThinking(delta) {
        if (!currentThinkingEl) {
          const details = document.createElement('details');
          details.className = 'tva-trace';
          details.innerHTML =
            '<summary><span class="tva-tool-name">thinking</span></summary>' +
            '<div class="tva-trace-body"></div>';
          messagesEl.appendChild(details);
          currentThinkingEl = details.querySelector('.tva-trace-body');
        }
        currentThinkingEl.textContent += delta;
        scrollDown();
      },

      onText(delta) {
        if (!currentAssistantEl) {
          currentAssistantEl = addEl('tva-msg assistant', '');
          currentAssistantEl.dataset.raw = '';
        }
        currentAssistantEl.dataset.raw += delta;
        currentAssistantEl.innerHTML = renderText(currentAssistantEl.dataset.raw);
        scrollDown();
      },

      onToolStart({ id, name, input }) {
        currentAssistantEl = null;
        const details = document.createElement('details');
        details.className = 'tva-trace';
        details.innerHTML = `
          <summary>
            <span class="tva-tool-name">${esc(name)}</span>
            <span class="tva-status pending">running…</span>
          </summary>
          <div class="tva-trace-body">${esc(JSON.stringify(input, null, 2))}</div>`;
        messagesEl.appendChild(details);
        toolEls.set(id, details);
        scrollDown();
      },

      onToolResult({ id, ok, result }) {
        const details = toolEls.get(id);
        if (!details) return;
        toolEls.delete(id);
        const status = details.querySelector('.tva-status');
        status.className = 'tva-status ' + (ok ? 'ok' : 'err');
        status.textContent = ok ? 'done' : 'failed';
        const body = details.querySelector('.tva-trace-body');
        const rendered = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        body.textContent += '\n\n→ ' + rendered;
        if (!ok) details.open = true;
        scrollDown();
      },

      onConfirm({ name, input }) {
        currentAssistantEl = null;
        return new Promise((resolve) => {
          const el = document.createElement('div');
          el.className = 'tva-confirm';
          el.innerHTML = `
            <div>Allow <b>${esc(name)}</b>?</div>
            <div class="tva-trace-body" style="padding:6px 0 0">${esc(JSON.stringify(input, null, 2).slice(0, 600))}</div>
            <div class="tva-confirm-actions">
              <button class="tva-btn primary" data-yes>Allow</button>
              <button class="tva-btn" data-no>Deny</button>
            </div>`;
          messagesEl.appendChild(el);
          scrollDown();

          const finish = (allowed) => {
            el.querySelector('.tva-confirm-actions').remove();
            el.insertAdjacentHTML('beforeend',
              `<div style="margin-top:6px;opacity:.7">${allowed ? 'Allowed' : 'Denied'}</div>`);
            resolve(allowed);
          };
          el.querySelector('[data-yes]').addEventListener('click', () => finish(true));
          el.querySelector('[data-no]').addEventListener('click', () => finish(false));
        });
      },

      onDone() { endRun('ok'); },

      onError(err) {
        addEl('tva-msg error', esc(err?.message || String(err)));
        endRun('err');
      },
    };
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    build();
    setStatus('warn', 'connecting…');
    greet();

    capabilities = await window.TVAgentBridge.probeWhenReady();

    if (!capabilities.tradingViewApi || !capabilities.chart) {
      setStatus('err', 'no chart');
      addEl('tva-msg error',
        esc('Could not reach the TradingView API on this page. Open a chart at ' +
            'tradingview.com/chart/ and reload.'));
      return;
    }

    setStatus(capabilities.loggedIn ? 'ok' : 'warn', capabilities.loggedIn ? 'ready' : 'logged out');
    messagesEl.innerHTML = '';
    greet();

    agent = new window.TVAgentRuntime.Agent({ capabilities, handlers: handlers() });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle-panel' && root) root.classList.toggle('tva-hidden');
  });

  boot();
})();
