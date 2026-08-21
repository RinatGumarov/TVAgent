/** Runs the real agent.js with the worker port and the page bridge faked. */
import { check, section, report } from './helpers/check.mjs';
import { readSource, tick } from './helpers/load.mjs';

/**
 * A worker port driven by hand. `answer` hands back one assistant turn;
 * until then the agent is parked in #turn().
 */
function makePort() {
  const port = {
    posted: [],
    listeners: { message: [], disconnect: [] },
    disconnected: 0,
    postMessage(msg) { port.posted.push(msg); },
    disconnect() { port.disconnected++; },
    onMessage: { addListener: (fn) => port.listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => port.listeners.disconnect.push(fn) },
    /** What the worker would send back for one turn. */
    answer(content, stopReason = 'tool_use') {
      port.listeners.message.slice().forEach((fn) =>
        fn({ type: 'done', message: { content, stop_reason: stopReason } })
      );
    },
    fail(error) {
      port.listeners.message.slice().forEach((fn) => fn({ type: 'error', error }));
    },
  };
  return port;
}

const textTurn = (text) => [{ type: 'text', text }];
const toolTurn = (...names) =>
  names.map((name, i) => ({ type: 'tool_use', id: `tu_${name}_${i}`, name, input: {} }));

function setup({ capabilities = { pine: true, series: true, strategy: true }, tool } = {}) {
  const win = {};
  const ports = [];
  const events = [];

  // The real tool list, so the permission levels are the shipped ones.
  new Function('window', readSource('content/tools.js'))(win);

  win.TVAgentBridge = {
    calls: [],
    call(name, input) {
      win.TVAgentBridge.calls.push(name);
      return tool ? tool(name, input) : Promise.resolve({ ok: true, name, input });
    },
  };

  const chrome = {
    runtime: {
      connect() {
        const port = makePort();
        ports.push(port);
        return port;
      },
    },
  };

  new Function('window', 'chrome', readSource('content/agent.js'))(win, chrome);

  // Confirmation is a promise resolved by hand, because the question is what
  // happens while the card is on screen.
  let resolveConfirm = null;
  const handlers = {
    autoApprove: () => false,
    onConfirm: () => new Promise((r) => (resolveConfirm = r)),
    onDone: (info) => events.push({ done: info }),
    onError: (err) => events.push({ error: err.message }),
    onToolStart: (info) => events.push({ toolStart: info.name }),
    onToolResult: (info) => events.push({ toolResult: info.name, ok: info.ok }),
  };

  const agent = new win.TVAgentRuntime.Agent({ capabilities, handlers });
  return {
    agent,
    ports,
    events,
    bridge: win.TVAgentBridge,
    port: () => ports[ports.length - 1],
    allow: (yes) => resolveConfirm(yes),
    hasConfirm: () => resolveConfirm !== null,
  };
}

/** The tool_result blocks the conversation carries, in order. */
const results = (agent) =>
  agent.messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));

section('New chat while a run is in flight');

{
  const h = setup();
  h.agent.send('do a thing');
  await tick();
  h.port().answer(toolTurn('get_chart_context'));
  await tick();

  // The agent is inside its tool call. New chat lands here.
  h.agent.reset();
  await tick();
  h.port()?.answer(textTurn('late'));
  await tick();

  check('the history is empty', h.agent.messages, []);
  check('and the agent is idle', h.agent.running, false);

  h.agent.send('a fresh question');
  await tick();
  check('the fresh chat starts with a user turn', h.agent.messages[0].role, 'user');
  check('and it is the new message', h.agent.messages[0].content, 'a fresh question');
}

section('Stop on the last tool of a batch');

{
  const h = setup();
  h.agent.send('do two things');
  await tick();
  h.port().answer(toolTurn('get_chart_context', 'list_indicators'));
  await tick();
  await tick();

  h.agent.cancel();
  await tick();
  await tick();

  const ids = results(h.agent).map((r) => r.tool_use_id);
  check('every tool call is answered', ids.length, 2);
  check('exactly once each', new Set(ids).size, ids.length);
}

section('cancel() then send()');

{
  const h = setup();
  h.agent.send('first');
  await tick();
  h.agent.cancel();

  h.agent.send('second');
  await tick();

  // The abandoned turn now answers. It belongs to a run that is over.
  h.ports[0].answer(textTurn('an answer to the first question'));
  await tick();

  const roles = h.agent.messages.map((m) => m.role);
  check('the dead run wrote nothing', roles.filter((r) => r === 'assistant').length, 0);
  check('the live run owns the conversation', h.agent.messages.at(-1).content, 'second');

  h.ports[1].answer(textTurn('an answer to the second'));
  await tick();
  check('and its own answer lands', h.agent.messages.at(-1).content, textTurn('an answer to the second'));
  check('the agent is idle exactly once at the end', h.agent.running, false);
}

section('Allow pressed after Stop');

{
  const h = setup();
  h.agent.send('write me a strategy');
  await tick();
  h.port().answer(toolTurn('set_pine_code'));
  await tick();

  check('a level 2 tool asks first', h.hasConfirm(), true);

  h.agent.cancel();
  await tick();

  h.allow(true); // the user clicks Allow on a card left over from a stopped run
  await tick();
  await tick();

  check('the tool did not run', h.bridge.calls, []);
}

{
  // The ordinary path still works.
  const h = setup();
  h.agent.send('write me a strategy');
  await tick();
  h.port().answer(toolTurn('set_pine_code'));
  await tick();
  h.allow(true);
  await tick();
  check('Allow during a live run does run it', h.bridge.calls, ['set_pine_code']);
}

section('what may be called at all');

{
  const h = setup();
  h.agent.send('go');
  await tick();
  // Names that are not tools: a hallucination, an internal driver method, and
  // a property every object inherits.
  h.port().answer(toolTurn('make_me_rich', 'widgetbar_activate', 'constructor'));
  await tick();
  await tick();

  check('none of them reached the driver', h.bridge.calls, []);
  const answers = results(h.agent);
  check('each is answered so the conversation stays valid', answers.length, 3);
  check('and each is answered as an error', answers.every((r) => r.is_error), true);
  check('saying there is no such tool', /no tool called/.test(answers[0].content), true);
}

{
  const h = setup({ capabilities: { pine: false, series: true, strategy: true } });
  h.agent.send('write pine');
  await tick();
  h.port().answer(toolTurn('set_pine_code'));
  await tick();
  await tick();

  check('a tool the chart cannot offer is not run', h.bridge.calls, []);
  check('and the model is told why', /not available/.test(results(h.agent)[0].content), true);
}

{
  // Auto-approve covers level 2 and stops there.
  const h = setup();
  h.agent.handlers.autoApprove = () => true;
  h.agent.send('write pine');
  await tick();
  h.port().answer(toolTurn('set_pine_code'));
  await tick();
  await tick();

  check('auto-approve runs a level 2 tool without a card', h.bridge.calls, ['set_pine_code']);
  check('and no confirmation was asked for', h.hasConfirm(), false);
}

section('an ordinary run');

{
  const h = setup();
  h.agent.send('what am I looking at?');
  await tick();
  h.port().answer(toolTurn('get_chart_context'));
  await tick();
  await tick();
  h.port().answer(textTurn('You are on BTCUSD.'), 'end_turn');
  await tick();

  check('the tool ran', h.bridge.calls, ['get_chart_context']);
  check('and its result went back', results(h.agent).length, 1);
  check('the run finished', h.events.some((e) => e.done && !e.done.cancelled), true);
  check('and the agent is idle', h.agent.running, false);
}

/**
 * A turn that came back with nothing in it: the worker drops content blocks
 * the API will not accept back, and an empty assistant turn must not be
 * recorded.
 */
section('a turn with no content left in it');

{
  const h = setup();
  h.agent.send('hello?');
  await tick();
  h.port().answer([], 'max_tokens');
  await tick();

  const roles = h.agent.messages.map((m) => m.role);
  check('no empty assistant turn was recorded', roles, ['user']);
  check('the run ended rather than looping', h.events.some((e) => e.done), true);
  check('and the agent is idle', h.agent.running, false);
}

{
  // The same turn, but with something worth keeping in it.
  const h = setup();
  h.agent.send('hello?');
  await tick();
  h.port().answer(textTurn('Hi.'), 'end_turn');
  await tick();

  check('a turn that does say something is recorded', h.agent.messages.map((m) => m.role), ['user', 'assistant']);
}

report();
