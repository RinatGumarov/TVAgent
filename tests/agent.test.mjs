/** Runs the real agent.js with the worker port and the page bridge faked. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, tick } from './helpers/load.mjs';

/**
 * A worker port driven by hand. `answer` hands back one assistant turn;
 * until then the agent is parked in #turn().
 */
function makePort() {
  const port = {
    posted: [],
    listeners: { message: [], disconnect: [] },
    disconnected: 0,
    postMessage(msg) {
      port.posted.push(msg);
    },
    disconnect() {
      port.disconnected++;
    },
    onMessage: { addListener: (fn) => port.listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => port.listeners.disconnect.push(fn) },
    /** What the worker would send back for one turn. */
    answer(content, stopReason = 'tool_use') {
      port.listeners.message
        .slice()
        .forEach((fn) => fn({ type: 'done', message: { content, stop_reason: stopReason } }));
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

  // The real tool list comes bundled in, so the permission levels are the
  // shipped ones.
  const runtime = loadModule('content/agent.js', { window: win, chrome });

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

  const agent = new runtime.Agent({ capabilities, handlers });
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

describe('New chat while a run is in flight', async () => {
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

    const got1 = [...h.agent.messages];
    const want1 = [];
    it('the history is empty', () => {
      assert.deepStrictEqual(got1, want1);
    });
    const got2 = h.agent.running;
    const want2 = false;
    it('and the agent is idle', () => {
      assert.deepStrictEqual(got2, want2);
    });

    h.agent.send('a fresh question');
    await tick();
    const got3 = h.agent.messages[0].role;
    const want3 = 'user';
    it('the fresh chat starts with a user turn', () => {
      assert.deepStrictEqual(got3, want3);
    });
    const got4 = h.agent.messages[0].content;
    const want4 = 'a fresh question';
    it('and it is the new message', () => {
      assert.deepStrictEqual(got4, want4);
    });
  }
});

describe('Stop on the last tool of a batch', async () => {
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
    const got5 = ids.length;
    const want5 = 2;
    it('every tool call is answered', () => {
      assert.deepStrictEqual(got5, want5);
    });
    const got6 = new Set(ids).size;
    const want6 = ids.length;
    it('exactly once each', () => {
      assert.deepStrictEqual(got6, want6);
    });
  }
});

describe('cancel() then send()', async () => {
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
    const got7 = roles.filter((r) => r === 'assistant').length;
    const want7 = 0;
    it('the dead run wrote nothing', () => {
      assert.deepStrictEqual(got7, want7);
    });
    const got8 = h.agent.messages.at(-1).content;
    const want8 = 'second';
    it('the live run owns the conversation', () => {
      assert.deepStrictEqual(got8, want8);
    });

    h.ports[1].answer(textTurn('an answer to the second'));
    await tick();
    const got9 = h.agent.messages.at(-1).content;
    const want9 = textTurn('an answer to the second');
    it('and its own answer lands', () => {
      assert.deepStrictEqual(got9, want9);
    });
    const got10 = h.agent.running;
    const want10 = false;
    it('the agent is idle exactly once at the end', () => {
      assert.deepStrictEqual(got10, want10);
    });
  }
});

describe('Allow pressed after Stop', async () => {
  {
    const h = setup();
    h.agent.send('write me a strategy');
    await tick();
    h.port().answer(toolTurn('set_pine_code'));
    await tick();

    const got11 = h.hasConfirm();
    const want11 = true;
    it('a level 2 tool asks first', () => {
      assert.deepStrictEqual(got11, want11);
    });

    h.agent.cancel();
    await tick();

    h.allow(true); // the user clicks Allow on a card left over from a stopped run
    await tick();
    await tick();

    const got12 = h.bridge.calls;
    const want12 = [];
    it('the tool did not run', () => {
      assert.deepStrictEqual(got12, want12);
    });
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
    const got13 = h.bridge.calls;
    const want13 = ['set_pine_code'];
    it('Allow during a live run does run it', () => {
      assert.deepStrictEqual(got13, want13);
    });
  }
});

describe('what may be called at all', async () => {
  {
    const h = setup();
    h.agent.send('go');
    await tick();
    // Names that are not tools: a hallucination, an internal driver method, and
    // a property every object inherits.
    h.port().answer(toolTurn('make_me_rich', 'widgetbar_activate', 'constructor'));
    await tick();
    await tick();

    const got14 = h.bridge.calls;
    const want14 = [];
    it('none of them reached the driver', () => {
      assert.deepStrictEqual(got14, want14);
    });
    const answers = results(h.agent);
    const got15 = answers.length;
    const want15 = 3;
    it('each is answered so the conversation stays valid', () => {
      assert.deepStrictEqual(got15, want15);
    });
    const got16 = answers.every((r) => r.is_error);
    const want16 = true;
    it('and each is answered as an error', () => {
      assert.deepStrictEqual(got16, want16);
    });
    const got17 = /no tool called/.test(answers[0].content);
    const want17 = true;
    it('saying there is no such tool', () => {
      assert.deepStrictEqual(got17, want17);
    });
  }

  {
    const h = setup({ capabilities: { pine: false, series: true, strategy: true } });
    h.agent.send('write pine');
    await tick();
    h.port().answer(toolTurn('set_pine_code'));
    await tick();
    await tick();

    const got18 = h.bridge.calls;
    const want18 = [];
    it('a tool the chart cannot offer is not run', () => {
      assert.deepStrictEqual(got18, want18);
    });
    const got19 = /not available/.test(results(h.agent)[0].content);
    const want19 = true;
    it('and the model is told why', () => {
      assert.deepStrictEqual(got19, want19);
    });
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

    const got20 = h.bridge.calls;
    const want20 = ['set_pine_code'];
    it('auto-approve runs a level 2 tool without a card', () => {
      assert.deepStrictEqual(got20, want20);
    });
    const got21 = h.hasConfirm();
    const want21 = false;
    it('and no confirmation was asked for', () => {
      assert.deepStrictEqual(got21, want21);
    });
  }
});

describe('an ordinary run', async () => {
  {
    const h = setup();
    h.agent.send('what am I looking at?');
    await tick();
    h.port().answer(toolTurn('get_chart_context'));
    await tick();
    await tick();
    h.port().answer(textTurn('You are on BTCUSD.'), 'end_turn');
    await tick();

    const got22 = h.bridge.calls;
    const want22 = ['get_chart_context'];
    it('the tool ran', () => {
      assert.deepStrictEqual(got22, want22);
    });
    const got23 = results(h.agent).length;
    const want23 = 1;
    it('and its result went back', () => {
      assert.deepStrictEqual(got23, want23);
    });
    const got24 = h.events.some((e) => e.done && !e.done.cancelled);
    const want24 = true;
    it('the run finished', () => {
      assert.deepStrictEqual(got24, want24);
    });
    const got25 = h.agent.running;
    const want25 = false;
    it('and the agent is idle', () => {
      assert.deepStrictEqual(got25, want25);
    });
  }

  /**
   * A turn that came back with nothing in it: the worker drops content blocks
   * the API will not accept back, and an empty assistant turn must not be
   * recorded.
   */
});

describe('a turn with no content left in it', async () => {
  {
    const h = setup();
    h.agent.send('hello?');
    await tick();
    h.port().answer([], 'max_tokens');
    await tick();

    const roles = h.agent.messages.map((m) => m.role);
    const got26 = roles;
    const want26 = ['user'];
    it('no empty assistant turn was recorded', () => {
      assert.deepStrictEqual(got26, want26);
    });
    const got27 = h.events.some((e) => e.done);
    const want27 = true;
    it('the run ended rather than looping', () => {
      assert.deepStrictEqual(got27, want27);
    });
    const got28 = h.agent.running;
    const want28 = false;
    it('and the agent is idle', () => {
      assert.deepStrictEqual(got28, want28);
    });
  }

  {
    // The same turn, but with something worth keeping in it.
    const h = setup();
    h.agent.send('hello?');
    await tick();
    h.port().answer(textTurn('Hi.'), 'end_turn');
    await tick();

    const got29 = h.agent.messages.map((m) => m.role);
    const want29 = ['user', 'assistant'];
    it('a turn that does say something is recorded', () => {
      assert.deepStrictEqual(got29, want29);
    });
  }
});
