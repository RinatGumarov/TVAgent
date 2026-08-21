/**
 * TVAgent — the agent loop, probed against a local model.
 *
 * Takes the real schemas from tools.js and the real system prompt from
 * agent.js, points the driver at a mock, and runs the whole loop: model →
 * tool → result → model. It checks what a single call cannot — coherence
 * across several steps, no looping, and whether the arguments are accurate.
 *
 *   node loop-probe.mjs <model> [prompt]
 */
import { readSource } from './helpers/load.mjs';

const MAX_STEPS = 8;
const BASE_URL = process.env.BASE_URL || 'http://localhost:11434/v1';

// ---- the real tool schemas -------------------------------------------------
const window_ = {};
new Function('window', readSource('content/tools.js'))(window_);
const { TOOLS } = window_.TVAgentTools;
const KNOWN = new Set(TOOLS.map((t) => t.name));

const tools = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ---- the real system prompt ------------------------------------------------
const agentSrc = readSource('content/agent.js');
const promptBody = agentSrc.slice(
  agentSrc.indexOf('return `You are TVAgent') + 'return `'.length,
  agentSrc.indexOf('`;\n  }')
);
const SYSTEM = promptBody
  .replace('${caps.symbol || \'unknown\'}', 'BTCUSD')
  .replace('${caps.resolution || \'unknown\'}', '60')
  .replace(/\$\{caps\.loggedIn[^}]*\}/, '')
  .replace(/\$\{caps\.pine[^}]*\}/, '');

// ---- the stand-in driver ---------------------------------------------------
// Synthetic bars with known extremes: a high of 71234.5 on bar 30 and a low of
// 58120 on bar 70. If the model draws its lines at those prices then it really
// did read the data rather than invent the numbers.
const HIGH = 71234.5, LOW = 58120;
const BARS = Array.from({ length: 100 }, (_, i) => {
  const base = 64000 + Math.sin(i / 7) * 2500;
  const t = 1755000000 - (99 - i) * 3600;
  return {
    time: t,
    open: +(base - 40).toFixed(2),
    high: i === 30 ? HIGH : +(base + 180).toFixed(2),
    low: i === 70 ? LOW : +(base - 190).toFixed(2),
    close: +(base + 25).toFixed(2),
    volume: 1200 + (i % 13) * 40,
  };
});

let shapeId = 0, studyId = 0;
const studies = [];
const shapes = [];

const DRIVER = {
  get_chart_context: () => ({
    symbol: 'BTCUSD', timeframe: '60', chartType: 1,
    visibleRange: { from: BARS[0].time, to: BARS.at(-1).time },
    lastBar: BARS.at(-1),
    indicators: studies, drawings: shapes,
  }),
  get_series_data: ({ count = 100 } = {}) => {
    const out = BARS.slice(-Math.min(count, BARS.length));
    let high = out[0], low = out[0];
    for (const bar of out) {
      if (bar.high > high.high) high = bar;
      if (bar.low < low.low) low = bar;
    }
    return {
      symbol: 'BTCUSD', timeframe: '60', count: out.length,
      range: {
        high: { price: high.high, time: high.time },
        low: { price: low.low, time: low.time },
        first: { time: out[0].time, open: out[0].open },
        last: { time: out.at(-1).time, close: out.at(-1).close },
      },
      bars: out,
    };
  },
  set_symbol: ({ symbol }) => ({ symbol }),
  set_timeframe: ({ timeframe }) => ({ timeframe }),
  set_visible_range: (a) => ({ ok: true, ...a }),
  search_indicators: ({ query, limit = 20 }) => {
    const catalog = ['Moving Average Exponential', 'Moving Average Simple', 'Relative Strength Index',
      'MACD', 'Bollinger Bands', 'Volume', 'Average True Range', 'Stochastic'];
    const q = String(query || '').toLowerCase();
    const results = catalog.filter((n) => n.toLowerCase().includes(q)).slice(0, limit);
    return { total: results.length, results: results.map((name) => ({ name })) };
  },
  list_indicators: () => ({ indicators: studies }),
  add_indicator: ({ name, inputs = {}, overlay = false }) => {
    const known = ['Moving Average Exponential', 'Moving Average Simple', 'Relative Strength Index',
      'MACD', 'Bollinger Bands', 'Volume', 'Average True Range', 'Stochastic'];
    const resolved = known.find((n) => n.toLowerCase() === String(name).toLowerCase());
    if (!resolved) throw new Error(`No study named "${name}". Use search_indicators to find the display name.`);
    const id = `st_${++studyId}`;
    studies.push({ id, name: resolved, inputs, overlay });
    return { id, name: resolved, indicators: studies.map((s) => ({ id: s.id, name: s.name })) };
  },
  update_indicator: ({ id, inputs }) => ({ id, inputs }),
  remove_indicator: ({ id }) => ({ removed: id }),
  list_drawings: () => ({ drawings: shapes }),
  create_horizontal_line: ({ price, text }) => {
    const id = `sh_${++shapeId}`;
    shapes.push({ id, kind: 'horizontal_line', price, text });
    return { id, price };
  },
  create_vertical_line: ({ time }) => { const id = `sh_${++shapeId}`; shapes.push({ id, kind: 'vertical_line', time }); return { id }; },
  create_trend_line: (a) => { const id = `sh_${++shapeId}`; shapes.push({ id, kind: 'trend_line', ...a }); return { id }; },
  create_text: (a) => { const id = `sh_${++shapeId}`; shapes.push({ id, kind: 'text', ...a }); return { id }; },
  remove_drawing: ({ id }) => ({ removed: id }),
  open_pine_editor: () => ({ ok: true }),
  set_pine_code: () => ({ ok: true, compiled: true }),
  add_pine_to_chart: () => ({ id: `st_${++studyId}`, name: 'Custom Script' }),
  get_strategy_report: () => ({ netProfit: 1240.5, profitFactor: 1.8, maxDrawdown: 312.4, sharpe: 1.1, sortino: 1.6, trades: 42 }),
};

// ---- the loop --------------------------------------------------------------
const model = process.argv[2];
const userPrompt = process.argv[3] || 'mark the high and low of the visible range with horizontal lines';

const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }];
const trace = [];
let finalText = null, steps = 0;
const t0 = Date.now();

for (let i = 0; i < MAX_STEPS; i++) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false }),
  });
  if (!res.ok) { console.error(`HTTP ${res.status}:`, await res.text()); process.exit(1); }

  const msg = (await res.json()).choices?.[0]?.message ?? {};
  steps = i + 1;
  messages.push(msg);

  const calls = msg.tool_calls ?? [];
  if (calls.length === 0) { finalText = msg.content ?? ''; break; }

  for (const call of calls) {
    const name = call.function?.name;
    let args = {};
    let parseError = null;
    try { args = JSON.parse(call.function?.arguments || '{}'); }
    catch (e) { parseError = e.message; }

    let result, ok = true;
    if (parseError) { ok = false; result = `Error: invalid JSON arguments — ${parseError}`; }
    else if (!KNOWN.has(name)) { ok = false; result = `Error: no such tool "${name}".`; }
    else {
      try { result = DRIVER[name](args); }
      catch (e) { ok = false; result = `Error: ${e.message}`; }
    }

    trace.push({ step: steps, name, args, ok });
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    });
  }
}

// ---- what came of it -------------------------------------------------------
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n model   ${model}`);
console.log(` prompt  "${userPrompt}"`);
console.log(`  steps  ${steps}/${MAX_STEPS}   ${secs}s\n`);

for (const c of trace) {
  const a = JSON.stringify(c.args);
  console.log(`  ${c.step}. ${c.ok ? '✓' : '✗'} ${c.name}${a === '{}' ? '' : ' ' + (a.length > 90 ? a.slice(0, 90) + '…' : a)}`);
}

const seen = new Map();
let repeats = 0;
for (const c of trace) {
  const k = c.name + JSON.stringify(c.args);
  if (seen.has(k)) repeats++;
  seen.set(k, true);
}

console.log(`\n finished with an answer  ${finalText !== null ? 'yes' : 'NO — it hit the step limit'}`);
console.log(` failed calls             ${trace.filter((c) => !c.ok).length}`);
console.log(` repeated calls           ${repeats}`);
const drawn = shapes.filter((s) => s.kind === 'horizontal_line').map((s) => s.price);
if (drawn.length) {
  const hit = (p) => drawn.some((d) => Math.abs(Number(d) - p) < 1);
  console.log(` lines drawn at           ${drawn.join(', ')}`);
  console.log(` high ${HIGH} found        ${hit(HIGH) ? 'yes' : 'NO'}`);
  console.log(` low ${LOW} found          ${hit(LOW) ? 'yes' : 'NO'}`);
}
if (studies.length) console.log(` indicators               ${studies.map((s) => `${s.name} ${JSON.stringify(s.inputs)}`).join(' | ')}`);
if (finalText) console.log(`\n answer: ${finalText.trim().slice(0, 400)}`);
