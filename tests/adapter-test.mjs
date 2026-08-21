/**
 * TVAgent — the OpenAI-compatible adapter, against a live Ollama.
 *
 * Runs the REAL service-worker.js code. The worker is not a module and is tied
 * to chrome.*, so the globals it expects are handed in and its internals come
 * back out through a return. What this covers and loop-probe does not is
 * streamOpenAI + parseOpenAIStream: reading tool_calls out of an SSE stream and
 * reassembling them into Anthropic content blocks.
 *
 *   node adapter-test.mjs [model]
 */
import { readSource, loadShared } from './helpers/load.mjs';

const MODEL = process.argv[2] || 'gemma4:26b-a4b-it-qat';

const chrome = {
  action: { onClicked: { addListener() {} } },
  runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
  tabs: { sendMessage: () => Promise.resolve() },
  storage: { local: { get: async () => ({}) } },
};

const shared = loadShared('shared/models.js', 'shared/credentials.js');
const { streamOpenAI, toOpenAIMessages } = new Function(
  'chrome',
  'importScripts',
  'TVAgentModels',
  'TVAgentCredentials',
  `${readSource('background/service-worker.js')}\nreturn { streamOpenAI, toOpenAIMessages };`
)(chrome, () => {}, shared.TVAgentModels, shared.TVAgentCredentials);

// The schemas and the prompt are the real ones.
const window_ = {};
new Function('window', readSource('content/tools.js'))(window_);
const tools = window_.TVAgentTools.forApi(null);

const SYSTEM = `You are TVAgent, an assistant embedded in TradingView. You operate the user's chart directly through tools.
Current chart: BTCUSD on timeframe 60.
- Act on the chart rather than describing what the user could do. If they ask for EMAs, add them.
- Verify your own work from the values tools return.`;

const DRIVER = {
  get_chart_context: () => ({ symbol: 'BTCUSD', timeframe: '60', indicators: [], drawings: [] }),
  add_indicator: ({ name, inputs }) => ({ id: `st_${Math.random().toString(36).slice(2, 6)}`, name, inputs }),
  list_indicators: () => ({ indicators: [] }),
  search_indicators: () => ({ total: 1, results: [{ name: 'Moving Average Exponential' }] }),
  set_timeframe: ({ timeframe }) => ({ timeframe }),
};

const cfg = {
  provider: 'openai',
  baseUrl: process.env.BASE_URL || 'http://localhost:11434/v1',
  model: MODEL,
  apiKey: '',
  maxTokens: 4096,
  effort: 'high',
};

// The port, as agent.js sees it.
const seen = { text: 0, thinking: 0, blocks: [] };
const port = {
  postMessage(m) {
    if (m.type === 'text') seen.text += m.delta.length;
    else if (m.type === 'thinking') seen.thinking += m.delta.length;
    else if (m.type === 'block_start') seen.blocks.push(m.name ? `${m.blockType}:${m.name}` : m.blockType);
  },
};

// The same loop agent.js runs: assistant blocks into the history, tool results
// into a user turn.
const messages = [{ role: 'user', content: 'Add EMA 50 and EMA 200 to the chart, then tell me what is on it.' }];
const t0 = Date.now();
let steps = 0;

for (let i = 0; i < 6; i++) {
  const res = await streamOpenAI(cfg, { system: SYSTEM, messages, tools }, port, undefined);
  steps = i + 1;

  console.log(`\n─ step ${steps}  stop_reason=${res.stop_reason}  blocks=${res.content.length}`);
  for (const b of res.content) {
    if (b.type === 'tool_use') console.log(`   tool_use  ${b.name} ${JSON.stringify(b.input)}  id=${b.id}`);
    else if (b.type === 'text') console.log(`   text      ${b.text.trim().slice(0, 160)}`);
    else if (b.type === 'thinking') console.log(`   thinking  ${b.thinking.trim().slice(0, 80)}…`);
  }

  messages.push({ role: 'assistant', content: res.content });

  const calls = res.content.filter((b) => b.type === 'tool_use');
  if (!calls.length) break;

  messages.push({
    role: 'user',
    content: calls.map((c) => {
      try {
        const fn = DRIVER[c.name];
        if (!fn) throw new Error(`no such tool "${c.name}"`);
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(fn(c.input)) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: c.id, content: `Error: ${e.message}`, is_error: true };
      }
    }),
  });
}

console.log(`\n steps              ${steps}   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(` block_start        ${seen.blocks.join(', ') || '—'}`);
console.log(` streamed text      ${seen.text} chars`);
console.log(` streamed thinking  ${seen.thinking} chars`);

// The reverse mapping: an Anthropic history has to come out as a valid
// OpenAI array, with every tool turn answering a call that precedes it.
const mapped = toOpenAIMessages(SYSTEM, messages);
const roles = mapped.map((m) => m.role).join(' → ');
const orphan = mapped.some((m, i) =>
  m.role === 'tool' && !mapped.slice(0, i).some((p) => p.tool_calls?.some((c) => c.id === m.tool_call_id))
);
console.log(` history mapping    ${roles}`);
console.log(` orphaned tool turns ${orphan ? 'YES — mapping is wrong' : 'none'}`);
