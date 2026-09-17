/**
 * Runs the real panel.js under the fake DOM, with TVAgentMount,
 * TVAgentSettings, TVAgentBridge, TVAgentRuntime and TVAgentChat faked at
 * their interfaces.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, makeElement, click, fireInput, fireKeydown } from './helpers/dom.mjs';
import { loadModuleWith } from './helpers/load.mjs';

function makeChrome() {
  const messageListeners = [];
  return {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    _fireMessage(msg) {
      messageListeners.slice().forEach((fn) => fn(msg));
    },
  };
}

// --------------------------------------------------------- TVAgent* mocks

function makeChatModule(doc) {
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  function create(listEl) {
    const log = { user: [], notice: [], error: [], clear: 0, startRun: 0, endRun: 0 };
    function addMsg(kind, text) {
      const el = doc.createElement('div');
      el.className = 'tva-msg ' + kind;
      el.textContent = text;
      listEl.appendChild(el);
      return el;
    }
    return {
      log,
      clear() {
        log.clear++;
        listEl.children = [];
      },
      user(t) {
        log.user.push(t);
        return addMsg('user', t);
      },
      notice(t) {
        log.notice.push(t);
        return addMsg('notice', t);
      },
      error(t) {
        log.error.push(t);
        return addMsg('error', t);
      },
      startRun() {
        log.startRun++;
      },
      endRun() {
        log.endRun++;
      },
      onBlockStart() {},
      onThinking() {},
      onText() {},
      onToolStart() {},
      onToolResult() {},
      onConfirm() {
        return Promise.resolve(true);
      },
    };
  }

  return { esc, create };
}

/**
 * A ResizeObserver stub; resize(width) calls back with the same entries
 * contract the real one uses.
 */
function makeResizeObserverStub() {
  const state = { cb: null, observed: [] };
  state.ctor = class {
    constructor(cb) {
      state.cb = cb;
    }
    observe(el) {
      state.observed.push(el);
    }
    disconnect() {}
  };
  state.resize = (...widths) => state.cb(widths.map((width) => ({ contentRect: { width } })));
  return state;
}

/** A mount mock that answers immediately, with mode and root given up front. */
function makeMountMock(mode, root) {
  let calls = 0;
  const handlers = [];
  let toggleCalls = 0;
  return {
    async mount() {
      calls++;
      return { root, mode };
    },
    onActive(fn) {
      handlers.push(fn);
    },
    async toggle() {
      toggleCalls++;
    },
    get calls() {
      return calls;
    },
    get toggleCalls() {
      return toggleCalls;
    },
    handlers,
  };
}

function makeSettingsMock({ ready = true, autoApprove = false } = {}) {
  let refreshCalls = 0;
  let lastOnChange = null;
  let readyNow = ready;
  return {
    create(hostEl, opts) {
      lastOnChange = opts.onChange;
      return {
        ready: Promise.resolve(ready),
        isReady: () => readyNow,
        autoApprove: () => autoApprove,
        refresh: () => {
          refreshCalls++;
        },
        current: () => ({ provider: 'anthropic', model: 'claude-opus-5' }),
      };
    },
    get refreshCalls() {
      return refreshCalls;
    },
    get lastOnChange() {
      return lastOnChange;
    },
    setReady(value) {
      readyNow = value;
    },
  };
}

/**
 * The bridge, as panel.js uses it: one probe at boot, and a subscription for
 * the reports the driver pushes afterwards.
 */
function makeBridgeMock(capsValue) {
  const listeners = {};
  return {
    probeWhenReady: async () => capsValue,
    on(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    pushChart: (report) => (listeners['chart-changed'] || []).forEach((fn) => fn(report)),
    listenerCount: (type) => (listeners[type] || []).length,
  };
}

function makeRuntimeMock() {
  const instances = [];
  class Agent {
    constructor(opts) {
      this.capabilities = opts.capabilities;
      this.handlers = opts.handlers;
      this.sendCalls = [];
      this.cancelCalls = 0;
      this.resetCalls = 0;
      instances.push(this);
    }
    send(t) {
      this.sendCalls.push(t);
    }
    cancel() {
      this.cancelCalls++;
    }
    reset() {
      this.resetCalls++;
    }
  }
  return { Agent, instances };
}

function caps(overrides = {}) {
  return {
    tradingViewApi: true,
    chart: true,
    loggedIn: true,
    symbol: 'BTCUSD',
    resolution: '60',
    pine: true,
    warnings: [],
    ...overrides,
  };
}

/**
 * Waits for a macrotask boundary rather than a guessed number of microtasks:
 * panel.js awaits async wrappers around the mocks' promises, and
 * setTimeout(0) outlasts however many ticks that adds.
 */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

async function load({ mount, settings, bridge, runtime, chat }) {
  const win = {};
  const doc = makeDocument();
  win.TVAgentChat = chat || makeChatModule(doc);
  win.TVAgentMount = mount;
  win.TVAgentSettings = settings;
  win.TVAgentBridge = bridge;
  win.TVAgentRuntime = runtime;
  const ro = makeResizeObserverStub();
  win.ResizeObserver = ro.ctor;
  const chr = makeChrome();

  // The shell is what is under test; its collaborators are doubles. The model
  // catalog is not one of them — panel.js reads the shipped list.
  const panel = await loadModuleWith(
    'content/panel.js',
    { window: win, document: doc, chrome: chr },
    {
      'content/panel-chat.js': 'TVAgentChat',
      'content/panel-mount.js': 'TVAgentMount',
      'content/panel-settings.js': 'TVAgentSettings',
      'content/agent.js': 'TVAgentRuntime',
    },
  );
  panel.start();
  return { win, doc, chrome: chr, ro };
}

/**
 * A complete, successful boot with default mocks; any part can be
 * overridden.
 */
async function bootedPanel(overrides = {}) {
  const root = makeElementRoot();
  const mode = overrides.mode || 'overlay';
  const mount = overrides.mount || makeMountMock(mode, root);
  const settings = overrides.settings || makeSettingsMock(overrides.settingsOpts);
  const bridge = overrides.bridge || makeBridgeMock(overrides.caps || caps());
  const runtime = overrides.runtime || makeRuntimeMock();

  const { win, doc, chrome, ro } = await load({
    mount,
    settings,
    bridge,
    runtime,
    chat: overrides.chat,
  });
  await flush();
  await flush();
  if (overrides.width !== undefined) ro.resize(overrides.width);

  const q = (sel) => root.querySelector(sel);
  return {
    win,
    doc,
    chrome,
    ro,
    root,
    mount,
    settings,
    bridge,
    runtime,
    resize: ro.resize,
    ctxChipEl: q('#tva-in-context'),
    ctxLabelEl: q('#tva-in-context-label'),
    ctxPopEl: q('#tva-ctx-pop'),
    listEl: q('#tva-list'),
    settingsEl: q('#tva-settings'),
    emptyEl: q('#tva-empty'),
    inputEl: q('#tva-input'),
    sendBtn: q('#tva-send'),
    statusEl: q('#tva-status'),
    contextEl: q('#tva-where'),
    composerEl: q('.tva-composer'),
    agent: runtime.instances[0] || null,
  };
}

const makeElementRoot = () => makeElement('div');

// ============================================================================
// The formatting formula is spelled out as panel.js spells it, so the test does
// not depend on the locale's grouping character.
function fmtPrice(n, maxDigits) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDigits,
  }).format(n);
}

describe('boot: mount before build', async () => {
  {
    let resolveMount;
    const mountPromise = new Promise((r) => (resolveMount = r));
    const root = makeElementRoot();
    let mountCalls = 0;
    const mount = {
      async mount() {
        mountCalls++;
        return mountPromise;
      },
      onActive() {},
      async toggle() {},
    };
    const settings = makeSettingsMock({ ready: true });
    const bridge = makeBridgeMock(caps());
    const runtime = makeRuntimeMock();

    await load({ mount, settings, bridge, runtime });

    const got1 = mountCalls;
    const want1 = 1;
    it('mount() is called once, straight away', () => {
      assert.deepStrictEqual(got1, want1);
    });
    const got2 = root.children.length;
    const want2 = 0;
    it('build() has not run — root is empty until mount() resolves', () => {
      assert.deepStrictEqual(got2, want2);
    });

    resolveMount({ root, mode: 'overlay' });
    await flush();
    const got3 = root.children.length > 0;
    const want3 = true;
    it('once mount() resolves, build() has run and the header is there', () => {
      assert.deepStrictEqual(got3, want3);
    });
    const got4 = root.querySelector('.tva-header') !== null;
    const want4 = true;
    it('the header went in as a header', () => {
      assert.deepStrictEqual(got4, want4);
    });
  }
});

describe('boot: settings.ready decides whether the settings screen opens', async () => {
  {
    const h = await bootedPanel({ settingsOpts: { ready: false } });
    const got5 = h.settingsEl.classList.contains('tva-hidden');
    const want5 = false;
    it('ready=false: the settings screen is open', () => {
      assert.deepStrictEqual(got5, want5);
    });
    const got6 = h.listEl.classList.contains('tva-hidden');
    const want6 = true;
    it('ready=false: the list is hidden', () => {
      assert.deepStrictEqual(got6, want6);
    });
    const got7 = h.composerEl.classList.contains('tva-hidden');
    const want7 = true;
    it('ready=false: the composer is hidden', () => {
      assert.deepStrictEqual(got7, want7);
    });
    const got8 = h.emptyEl.classList.contains('tva-hidden');
    const want8 = true;
    it('ready=false: the empty state is hidden — we are in settings', () => {
      assert.deepStrictEqual(got8, want8);
    });
  }

  {
    const h = await bootedPanel({ settingsOpts: { ready: true } });
    const got9 = h.settingsEl.classList.contains('tva-hidden');
    const want9 = true;
    it('ready=true: the settings screen stays closed', () => {
      assert.deepStrictEqual(got9, want9);
    });
    const got10 = h.listEl.classList.contains('tva-hidden');
    const want10 = false;
    it('ready=true: the list is visible', () => {
      assert.deepStrictEqual(got10, want10);
    });
    const got11 = h.composerEl.classList.contains('tva-hidden');
    const want11 = false;
    it('ready=true: the composer is visible', () => {
      assert.deepStrictEqual(got11, want11);
    });
  }
});

describe('boot: a failed probe shows an error and creates no Agent', async () => {
  {
    const h = await bootedPanel({ caps: caps({ tradingViewApi: false, chart: false }) });
    const got12 = h.runtime.instances.length;
    const want12 = 0;
    it('no Agent was created', () => {
      assert.deepStrictEqual(got12, want12);
    });
    const got13 = h.statusEl.className;
    const want13 = 'tva-status err';
    it('the status is an error', () => {
      assert.deepStrictEqual(got13, want13);
    });

    const errCall = h.listEl.querySelector('.tva-msg.error');
    const got14 = errCall !== null;
    const want14 = true;
    it('an error message appeared in the list', () => {
      assert.deepStrictEqual(got14, want14);
    });
    const got15 = errCall.textContent.includes('Could not reach the TradingView API');
    const want15 = true;
    it('the message names the TradingView API and /chart/', () => {
      assert.deepStrictEqual(got15, want15);
    });
  }
});

describe('boot: a successful probe creates an Agent', async () => {
  {
    const h = await bootedPanel({ caps: caps({ loggedIn: true }) });
    const got16 = h.runtime.instances.length;
    const want16 = 1;
    it('exactly one Agent was created', () => {
      assert.deepStrictEqual(got16, want16);
    });
    const got17 = h.statusEl.className;
    const want17 = 'tva-status ok';
    it('the status is connected', () => {
      assert.deepStrictEqual(got17, want17);
    });
  }

  {
    const h = await bootedPanel({ caps: caps({ loggedIn: false }) });
    const got18 = h.runtime.instances.length;
    const want18 = 1;
    it('an Agent is still created when loggedIn is false — that is a status, not a blocker', () => {
      assert.deepStrictEqual(got18, want18);
    });
    const got19 = h.statusEl.className;
    const want19 = 'tva-status warn';
    it('the status is logged out', () => {
      assert.deepStrictEqual(got19, want19);
    });
  }

  // ============================================================================
});

describe('boot: each of the four failure points shows an error rather than nothing', async () => {
  // One block per failure point; mount() gets its own, because when it fails
  // there is no panel to write an error into.

  {
    // mount() fails: build() has not run, so the error goes into a standalone
    // banner on documentElement.
    const mount = {
      async mount() {
        throw new Error('mount blew up');
      },
      onActive() {},
      async toggle() {},
    };
    const settings = makeSettingsMock({ ready: true });
    const bridge = makeBridgeMock(caps());
    const runtime = makeRuntimeMock();

    const { doc } = await load({ mount, settings, bridge, runtime });
    await flush();
    await flush();

    const banner = doc.documentElement.querySelector('#tva-boot-error');
    const got20 = banner !== null;
    const want20 = true;
    it('an error banner appeared straight on documentElement', () => {
      assert.deepStrictEqual(got20, want20);
    });
    const got21 = (banner?.textContent || '').includes('mount blew up');
    const want21 = true;
    it('the banner names the cause', () => {
      assert.deepStrictEqual(got21, want21);
    });
    const got22 = runtime.instances.length;
    const want22 = 0;
    it('no Agent — build() never ran', () => {
      assert.deepStrictEqual(got22, want22);
    });
  }

  {
    // probeWhenReady() rejects. bridge.js does not do that today, but boot()
    // must not rely on it.
    const bridge = {
      probeWhenReady: async () => {
        throw new Error('probe rejected');
      },
    };
    const h = await bootedPanel({ bridge });

    const got23 = h.statusEl.className;
    const want23 = 'tva-status err';
    it('the status is err', () => {
      assert.deepStrictEqual(got23, want23);
    });
    const got24 = h.runtime.instances.length;
    const want24 = 0;
    it('no Agent was created', () => {
      assert.deepStrictEqual(got24, want24);
    });
    const errCall = h.listEl.querySelector('.tva-msg.error');
    const got25 = errCall !== null;
    const want25 = true;
    it('the error message is in the list', () => {
      assert.deepStrictEqual(got25, want25);
    });
    const got26 = (errCall?.textContent || '').includes('probe rejected');
    const want26 = true;
    it('the message names the cause', () => {
      assert.deepStrictEqual(got26, want26);
    });
  }

  // ============================================================================
});

describe('context row: the price', async () => {
  {
    const h = await bootedPanel({
      caps: caps({ symbol: 'BTCUSDT', resolution: '240', price: 121480 }),
    });
    const expected = `BTCUSDT · 4h · ${fmtPrice(121480, 2)}`;
    const got27 = h.contextEl.textContent;
    const want27 = expected;
    it('context row: symbol · timeframe · price', () => {
      assert.deepStrictEqual(got27, want27);
    });
  }

  {
    // The report has no price, exactly as the real probe leaves it until the
    // bars have loaded. The context row must not draw a spare separator or the
    // word "undefined".
    const h = await bootedPanel({ caps: caps({ symbol: 'BTCUSDT', resolution: '240' }) });
    const got28 = h.contextEl.textContent;
    const want28 = 'BTCUSDT · 4h';
    it('with no price: symbol and timeframe, no dangling separator', () => {
      assert.deepStrictEqual(got28, want28);
    });
  }

  {
    // An instrument under $1: two decimals would round it to 0.00.
    const h = await bootedPanel({
      caps: caps({ symbol: 'PEPEUSDT', resolution: '60', price: 0.0004567 }),
    });
    const expected = `PEPEUSDT · 1h · ${fmtPrice(0.0004567, 6)}`;
    const got29 = h.contextEl.textContent;
    const want29 = expected;
    it('a sub-dollar price is not rounded to 0.00 — six decimals', () => {
      assert.deepStrictEqual(got29, want29);
    });
    const got30 = h.contextEl.textContent.includes('0.00 ');
    const want30 = false;
    it('the real value is on screen, not 0.00', () => {
      assert.deepStrictEqual(got30, want30);
    });
  }

  {
    // The chip names what travels in the system prompt: the symbol and the
    // timeframe, not the price.
    const h = await bootedPanel({
      caps: caps({ symbol: 'BTCUSDT', resolution: '240', price: 121480 }),
    });
    const got31 = h.ctxLabelEl.textContent;
    const want31 = 'BTCUSDT · 4h in context';
    it('the chip names the symbol and the timeframe only', () => {
      assert.deepStrictEqual(got31, want31);
    });
    const got32 = h.ctxLabelEl.textContent.includes(fmtPrice(121480, 2));
    const want32 = false;
    it('the price is not in the chip label', () => {
      assert.deepStrictEqual(got32, want32);
    });
    const got33 = h.ctxChipEl.attrs.title;
    const want33 = `BTCUSDT · 4h · ${fmtPrice(121480, 2)}`;
    it('but the chip title carries the whole line', () => {
      assert.deepStrictEqual(got33, want33);
    });
  }

  // ============================================================================
});

describe('the timeframe is written for a reader, not as a TradingView resolution', async () => {
  {
    // Anything unrecognised is passed through untouched rather than guessed at.
    const cases = [
      ['1', '1m'],
      ['45', '45m'],
      ['60', '1h'],
      ['90', '90m'],
      ['240', '4h'],
      ['720', '12h'],
      ['30S', '30s'],
      ['D', '1D'],
      ['1D', '1D'],
      ['3D', '3D'],
      ['W', '1W'],
      ['M', '1M'],
      ['12M', '12M'],
      ['10R', '10R'],
    ];
    for (const [raw, want] of cases) {
      const h = await bootedPanel({ caps: caps({ symbol: 'BTCUSDT', resolution: raw }) });
      const got34 = h.contextEl.textContent;
      const want34 = `BTCUSDT · ${want}`;
      it(`${raw} → ${want}`, () => {
        assert.deepStrictEqual(got34, want34);
      });
    }

    const h = await bootedPanel({ caps: caps({ symbol: 'BTCUSDT', resolution: '' }) });
    const got35 = h.contextEl.textContent;
    const want35 = 'BTCUSDT';
    it('an empty timeframe leaves no dangling separator', () => {
      assert.deepStrictEqual(got35, want35);
    });
  }

  // ============================================================================
});

describe('onActive: registered only in native mode, and focuses the input', async () => {
  {
    const h = await bootedPanel({ mode: 'native' });
    const got36 = h.mount.handlers.length;
    const want36 = 1;
    it('in native mode onActive is registered', () => {
      assert.deepStrictEqual(got36, want36);
    });

    const handler = h.mount.handlers[0];
    const got37 = h.inputEl._focusCount;
    const want37 = 0;
    it('focus() has not been called yet', () => {
      assert.deepStrictEqual(got37, want37);
    });
    handler(true);
    const got38 = h.inputEl._focusCount;
    const want38 = 1;
    it('active=true focuses the input', () => {
      assert.deepStrictEqual(got38, want38);
    });
    handler(false);
    const got39 = h.inputEl._focusCount;
    const want39 = 1;
    it('active=false does not focus again', () => {
      assert.deepStrictEqual(got39, want39);
    });
  }

  {
    const h = await bootedPanel({ mode: 'overlay' });
    const got40 = h.mount.handlers.length;
    const want40 = 0;
    it('in overlay mode onActive is NOT registered', () => {
      assert.deepStrictEqual(got40, want40);
    });
  }

  // ============================================================================
});

describe('send: empty and whitespace input is not sent', async () => {
  {
    const h = await bootedPanel();
    h.inputEl.value = '';
    fireInput(h.inputEl);
    click(h.sendBtn);
    const got41 = h.agent.sendCalls;
    const want41 = [];
    it('empty input: agent.send was not called', () => {
      assert.deepStrictEqual(got41, want41);
    });
  }
});

describe('send: disclosure and provider configuration are a hard gate', async () => {
  {
    const h = await bootedPanel({ settingsOpts: { ready: false } });
    // The settings screen opens at boot; closing it must not let a message
    // through.
    click(h.root.querySelector('#tva-gear'));
    const got42 = h.settingsEl.classList.contains('tva-hidden');
    const want42 = true;
    it('the chat can be reopened before setup is complete', () => {
      assert.deepStrictEqual(got42, want42);
    });

    h.inputEl.value = 'read my chart';
    fireInput(h.inputEl);
    click(h.sendBtn);

    const got43 = h.agent.sendCalls;
    const want43 = [];
    it('an unready configuration sends nothing to the model', () => {
      assert.deepStrictEqual(got43, want43);
    });
    const got44 = h.listEl.children.length;
    const want44 = 0;
    it('the user message is not added as though a run started', () => {
      assert.deepStrictEqual(got44, want44);
    });
    const got45 = h.settingsEl.classList.contains('tva-hidden');
    const want45 = false;
    it('the settings screen reopens at the missing disclosure or permission', () => {
      assert.deepStrictEqual(got45, want45);
    });
  }

  {
    const h = await bootedPanel();
    h.inputEl.value = '   \n  ';
    fireInput(h.inputEl);
    click(h.sendBtn);
    const got46 = h.agent.sendCalls;
    const want46 = [];
    it('whitespace only: agent.send was not called', () => {
      assert.deepStrictEqual(got46, want46);
    });
  }
});

describe('send: the button is disabled with no text and enabled with some', async () => {
  {
    const h = await bootedPanel();
    const got47 = h.sendBtn.disabled;
    const want47 = true;
    it('with an empty input the button is disabled', () => {
      assert.deepStrictEqual(got47, want47);
    });

    h.inputEl.value = 'hello';
    fireInput(h.inputEl);
    const got48 = h.sendBtn.disabled;
    const want48 = false;
    it('typing enables it', () => {
      assert.deepStrictEqual(got48, want48);
    });

    h.inputEl.value = '';
    fireInput(h.inputEl);
    const got49 = h.sendBtn.disabled;
    const want49 = true;
    it('clearing disables it again', () => {
      assert.deepStrictEqual(got49, want49);
    });
  }
});

describe('send: a second send while busy does not go through', async () => {
  {
    const h = await bootedPanel();
    h.inputEl.value = 'first message';
    fireInput(h.inputEl);
    click(h.sendBtn); // starts the run, busy=true

    const got50 = h.agent.sendCalls;
    const want50 = ['first message'];
    it('the first message reached agent.send', () => {
      assert.deepStrictEqual(got50, want50);
    });

    // Enter always calls submit(), which is where the busy guard lives; the
    // button cancels during a run instead.
    h.inputEl.value = 'second message while busy';
    fireInput(h.inputEl);
    fireKeydown(h.inputEl, { key: 'Enter' });
    const got51 = h.agent.sendCalls;
    const want51 = ['first message'];
    it('a second send during a run does not go through', () => {
      assert.deepStrictEqual(got51, want51);
    });
  }

  // ============================================================================
});

describe('run lifecycle: startRun/endRun', async () => {
  {
    const h = await bootedPanel();
    h.inputEl.value = 'go';
    fireInput(h.inputEl);
    click(h.sendBtn);

    const got52 = h.sendBtn.classList.contains('stop');
    const want52 = true;
    it('startRun: the button took the stop class', () => {
      assert.deepStrictEqual(got52, want52);
    });
    const got53 = h.sendBtn.attrs['aria-label'];
    const want53 = 'Stop';
    it('startRun: aria-label — Stop', () => {
      assert.deepStrictEqual(got53, want53);
    });
    const got54 = h.inputEl.value;
    const want54 = '';
    it('startRun: submit() cleared the input', () => {
      assert.deepStrictEqual(got54, want54);
    });
    const got55 = h.sendBtn.disabled;
    const want55 = false;
    it('startRun: the button is enabled even with an empty input', () => {
      assert.deepStrictEqual(got55, want55);
    });
    const got56 = h.statusEl.className;
    const want56 = 'tva-status warn';
    it('startRun: the status is working…', () => {
      assert.deepStrictEqual(got56, want56);
    });

    // endRun recomputes `disabled` from the current input, which may have
    // changed during the run.
    h.inputEl.value = 'draft typed while agent was working';
    h.agent.handlers.onDone({ stopReason: 'end_turn' });

    const got57 = h.sendBtn.classList.contains('stop');
    const want57 = false;
    it('endRun: the stop class is gone', () => {
      assert.deepStrictEqual(got57, want57);
    });
    const got58 = h.sendBtn.attrs['aria-label'];
    const want58 = 'Send';
    it('endRun: aria-label — Send', () => {
      assert.deepStrictEqual(got58, want58);
    });
    const got59 = h.sendBtn.disabled;
    const want59 = false;
    it('endRun: disabled was recomputed from the current, non-empty input', () => {
      assert.deepStrictEqual(got59, want59);
    });
    const got60 = h.statusEl.className;
    const want60 = 'tva-status ok';
    it('endRun: the status is connected', () => {
      assert.deepStrictEqual(got60, want60);
    });
  }

  {
    const h = await bootedPanel();
    h.inputEl.value = 'go';
    fireInput(h.inputEl);
    click(h.sendBtn);

    h.inputEl.value = ''; // nothing left typed
    h.agent.handlers.onDone({ stopReason: 'end_turn' });
  }

  {
    const h = await bootedPanel();
    h.inputEl.value = 'go';
    fireInput(h.inputEl);
    click(h.sendBtn);

    h.agent.handlers.onError(new Error('boom'));
    const got61 = h.statusEl.className;
    const want61 = 'tva-status err';
    it('onError moves the status to err', () => {
      assert.deepStrictEqual(got61, want61);
    });
    const got62 = h.listEl.querySelector('.tva-msg.error').textContent;
    const want62 = 'boom';
    it('onError shows the error text in the chat', () => {
      assert.deepStrictEqual(got62, want62);
    });
    const got63 = h.sendBtn.classList.contains('stop');
    const want63 = false;
    it('onError also drops the stop class — the run is over', () => {
      assert.deepStrictEqual(got63, want63);
    });
  }
});

describe('run lifecycle: the Stop button cancels rather than sends', async () => {
  {
    const h = await bootedPanel();
    h.inputEl.value = 'go';
    fireInput(h.inputEl);
    click(h.sendBtn); // the run starts, busy=true

    h.inputEl.value = 'this must not be sent';
    fireInput(h.inputEl);
    click(h.sendBtn); // during a run the same button is Stop

    const got64 = h.agent.cancelCalls;
    const want64 = 1;
    it('a second click during a run calls agent.cancel()', () => {
      assert.deepStrictEqual(got64, want64);
    });
    const got65 = h.agent.sendCalls;
    const want65 = ['go'];
    it('a second click during a run adds no new send', () => {
      assert.deepStrictEqual(got65, want65);
    });
  }

  // ============================================================================
});

describe('suggestions: a click sends straight away rather than filling the box', async () => {
  {
    const h = await bootedPanel();
    const card = h.root.querySelector('.tva-suggestion');
    const got66 = card !== null;
    const want66 = true;
    it('the suggestion card is there', () => {
      assert.deepStrictEqual(got66, want66);
    });

    const got67 = h.inputEl.value;
    const want67 = '';
    it('the input is empty before the click', () => {
      assert.deepStrictEqual(got67, want67);
    });
    click(card);

    const got68 = h.agent.sendCalls;
    const want68 = ['What am I looking at?'];
    it('clicking a suggestion sends its text straight away', () => {
      assert.deepStrictEqual(got68, want68);
    });
    const got69 = h.inputEl.value;
    const want69 = '';
    it('the input is NOT filled with it — deliberate, not a filled field', () => {
      assert.deepStrictEqual(got69, want69);
    });
  }

  // ============================================================================
});

describe('screens: showScreen(settings) hides the list and the composer', async () => {
  {
    const h = await bootedPanel();
    click(h.root.querySelector('#tva-gear'));

    const got70 = h.settingsEl.classList.contains('tva-hidden');
    const want70 = false;
    it('settings is open', () => {
      assert.deepStrictEqual(got70, want70);
    });
    const got71 = h.listEl.classList.contains('tva-hidden');
    const want71 = true;
    it('the list is hidden', () => {
      assert.deepStrictEqual(got71, want71);
    });
    const got72 = h.composerEl.classList.contains('tva-hidden');
    const want72 = true;
    it('the composer is hidden', () => {
      assert.deepStrictEqual(got72, want72);
    });
    const got73 = h.emptyEl.classList.contains('tva-hidden');
    const want73 = true;
    it('the empty state is hidden — we are in settings', () => {
      assert.deepStrictEqual(got73, want73);
    });
    const got74 = h.settings.refreshCalls;
    const want74 = 1;
    it('settings.refresh() was called on opening', () => {
      assert.deepStrictEqual(got74, want74);
    });
  }
});

describe('screens: going back restores the list and the composer', async () => {
  {
    const h = await bootedPanel();
    click(h.root.querySelector('#tva-gear')); // open
    click(h.root.querySelector('#tva-gear')); // close

    const got75 = h.settingsEl.classList.contains('tva-hidden');
    const want75 = true;
    it('settings closed again', () => {
      assert.deepStrictEqual(got75, want75);
    });
    const got76 = h.listEl.classList.contains('tva-hidden');
    const want76 = false;
    it('the list is visible again', () => {
      assert.deepStrictEqual(got76, want76);
    });
    const got77 = h.composerEl.classList.contains('tva-hidden');
    const want77 = false;
    it('the composer is visible again', () => {
      assert.deepStrictEqual(got77, want77);
    });
  }
});

describe('screens: the empty state shows only when the list is empty and we are not in settings', async () => {
  {
    const h = await bootedPanel();
    const got78 = h.emptyEl.classList.contains('tva-hidden');
    const want78 = false;
    it('the list starts empty, so the empty state shows', () => {
      assert.deepStrictEqual(got78, want78);
    });
  }
});

describe('screens: submit() — the first message hides the empty state at once', async () => {
  {
    // The message has to be appended before showScreen() recomputes the empty
    // state, or the placeholder sits next to the first message.
    const h = await bootedPanel();
    h.inputEl.value = 'first ever message';
    fireInput(h.inputEl);
    click(h.sendBtn);

    const got79 = h.listEl.children.length > 0;
    const want79 = true;
    it('after the first message the list is no longer empty', () => {
      assert.deepStrictEqual(got79, want79);
    });
    const got80 = h.emptyEl.classList.contains('tva-hidden');
    const want80 = true;
    it('the first message hides the empty state at once', () => {
      assert.deepStrictEqual(got80, want80);
    });

    h.inputEl.value = 'second message';
    fireInput(h.inputEl);
    h.agent.handlers.onDone({}); // release busy, or the second submit() is refused
    click(h.sendBtn);
    const got81 = h.emptyEl.classList.contains('tva-hidden');
    const want81 = true;
    it('and it stays hidden on the second', () => {
      assert.deepStrictEqual(got81, want81);
    });
  }

  // ============================================================================
});

describe('New chat resets the agent, clears the list, and the empty state returns', async () => {
  {
    const h = await bootedPanel();
    const dummy = h.doc.createElement('div');
    dummy.className = 'tva-msg user';
    h.listEl.appendChild(dummy);
    h.emptyEl.classList.add('tva-hidden');

    click(h.root.querySelector('#tva-new'));

    const got82 = h.agent.resetCalls;
    const want82 = 1;
    it('New chat calls agent.reset()', () => {
      assert.deepStrictEqual(got82, want82);
    });
    const got83 = h.listEl.children.length;
    const want83 = 0;
    it('New chat clears the list', () => {
      assert.deepStrictEqual(got83, want83);
    });
    const got84 = h.settingsEl.classList.contains('tva-hidden');
    const want84 = true;
    it('New chat returns to the chat screen', () => {
      assert.deepStrictEqual(got84, want84);
    });
    const got85 = h.emptyEl.classList.contains('tva-hidden');
    const want85 = false;
    it('New chat shows the empty state again', () => {
      assert.deepStrictEqual(got85, want85);
    });
  }
});

describe('narrow panel: the class comes from the panel’s own width', async () => {
  {
    const h = await bootedPanel({
      caps: caps({ symbol: 'BINGX:BTCUSDT.P', resolution: '240', price: 64446.7 }),
    });

    // Compared by reference, not by JSON: the fake DOM's nodes point back at
    // their parent and serialising one would cycle.
    const got86 = h.ro.observed.length;
    const want86 = 1;
    it('the ResizeObserver watches exactly one node', () => {
      assert.deepStrictEqual(got86, want86);
    });
    const got87 = h.ro.observed[0] === h.root;
    const want87 = true;
    it('and it is the panel root', () => {
      assert.deepStrictEqual(got87, want87);
    });
    const got88 = h.root.classList.contains('tva-narrow');
    const want88 = false;
    it('before the first measurement the panel counts as wide', () => {
      assert.deepStrictEqual(got88, want88);
    });

    h.resize(280);
    const got89 = h.root.classList.contains('tva-narrow');
    const want89 = true;
    it('280px is narrow', () => {
      assert.deepStrictEqual(got89, want89);
    });

    h.resize(400);
    const got90 = h.root.classList.contains('tva-narrow');
    const want90 = false;
    it('400px is wide again', () => {
      assert.deepStrictEqual(got90, want90);
    });

    // A hidden panel measures 0. That is "not rendered", not "narrow".
    h.resize(0);
    const got91 = h.root.classList.contains('tva-narrow');
    const want91 = false;
    it('a zero width changes nothing', () => {
      assert.deepStrictEqual(got91, want91);
    });

    // The threshold is shared with panel.css's narrow section: 320px inclusive.
    h.resize(320);
    const got92 = h.root.classList.contains('tva-narrow');
    const want92 = true;
    it('exactly 320px is narrow', () => {
      assert.deepStrictEqual(got92, want92);
    });
    h.resize(321);
    const got93 = h.root.classList.contains('tva-narrow');
    const want93 = false;
    it('321px is wide', () => {
      assert.deepStrictEqual(got93, want93);
    });

    // A real ResizeObserver delivers a batch of entries; the last one is current.
    h.resize(400, 260);
    const got94 = h.root.classList.contains('tva-narrow');
    const want94 = true;
    it('the last entry in the batch wins, not the first', () => {
      assert.deepStrictEqual(got94, want94);
    });
  }

  // ============================================================================
});

describe('narrow panel: the status and the context chip', async () => {
  {
    const h = await bootedPanel({
      caps: caps({ symbol: 'BINGX:BTCUSDT.P', resolution: '240', price: 64446.7 }),
    });
    const full = `BINGX:BTCUSDT.P · 4h · ${fmtPrice(64446.7, 2)}`;

    // CSS hides the word when narrow; the text stays in the DOM and in the
    // title.
    const got95 = h.statusEl.querySelector('span').textContent;
    const want95 = 'connected';
    it('the status word stays in the DOM', () => {
      assert.deepStrictEqual(got95, want95);
    });
    const got96 = h.statusEl.attrs.title;
    const want96 = 'connected';
    it('the status carries a title, which is what CSS hides', () => {
      assert.deepStrictEqual(got96, want96);
    });

    const got97 = h.contextEl.attrs.title;
    const want97 = full;
    it('the context row has the whole line as its title', () => {
      assert.deepStrictEqual(got97, want97);
    });
    const got98 = h.ctxLabelEl.textContent;
    const want98 = 'BINGX:BTCUSDT.P · 4h in context';
    it('wide: the chip shows symbol and timeframe', () => {
      assert.deepStrictEqual(got98, want98);
    });

    h.resize(260);
    const got99 = h.ctxLabelEl.textContent;
    const want99 = 'BTCUSDT.P';
    it('narrow: the chip shows the ticker only, no exchange', () => {
      assert.deepStrictEqual(got99, want99);
    });
    const got100 = h.ctxChipEl.attrs.title;
    const want100 = full;
    it('the chip title is still the whole line', () => {
      assert.deepStrictEqual(got100, want100);
    });

    h.resize(400);
    const got101 = h.ctxLabelEl.textContent;
    const want101 = 'BINGX:BTCUSDT.P · 4h in context';
    it('back at wide: symbol and timeframe again', () => {
      assert.deepStrictEqual(got101, want101);
    });
  }

  {
    const h = await bootedPanel({ caps: caps({ symbol: '', resolution: '' }) });
    const got102 = h.ctxChipEl.classList.contains('tva-hidden');
    const want102 = true;
    it('with no symbol the context chip is hidden entirely', () => {
      assert.deepStrictEqual(got102, want102);
    });
  }

  // ============================================================================
});

describe('the context popover', async () => {
  {
    const h = await bootedPanel({
      caps: caps({ symbol: 'BINGX:BTCUSDT.P', resolution: '240', price: 64446.7 }),
    });

    const got103 = h.root.querySelector('#tva-ctx-symbol').textContent;
    const want103 = 'BINGX:BTCUSDT.P';
    it('the symbol row is filled in', () => {
      assert.deepStrictEqual(got103, want103);
    });
    const got104 = h.root.querySelector('#tva-ctx-resolution').textContent;
    const want104 = '4h';
    it('the timeframe row is filled in for a reader', () => {
      assert.deepStrictEqual(got104, want104);
    });
    const got105 = h.root.querySelector('#tva-ctx-price').textContent;
    const want105 = fmtPrice(64446.7, 2);
    it('the price row is formatted as in the row above', () => {
      assert.deepStrictEqual(got105, want105);
    });

    // When wide the whole line is already visible — there is nothing to open.
    click(h.ctxChipEl);
    const got106 = h.ctxPopEl.classList.contains('tva-hidden');
    const want106 = true;
    it('when wide, clicking the chip opens nothing', () => {
      assert.deepStrictEqual(got106, want106);
    });
    const got107 = h.doc.listenerCount('click');
    const want107 = 0;
    it('and binds no document listeners', () => {
      assert.deepStrictEqual(got107, want107);
    });

    h.resize(260);
    click(h.ctxChipEl);
    const got108 = h.ctxPopEl.classList.contains('tva-hidden');
    const want108 = false;
    it('when narrow, a click opens the popover', () => {
      assert.deepStrictEqual(got108, want108);
    });
    const got109 = h.ctxChipEl.attrs['aria-expanded'];
    const want109 = 'true';
    it('aria-expanded=true', () => {
      assert.deepStrictEqual(got109, want109);
    });

    click(h.ctxChipEl);
    const got110 = h.ctxPopEl.classList.contains('tva-hidden');
    const want110 = true;
    it('a second click closes it', () => {
      assert.deepStrictEqual(got110, want110);
    });
    const got111 = h.ctxChipEl.attrs['aria-expanded'];
    const want111 = 'false';
    it('aria-expanded=false', () => {
      assert.deepStrictEqual(got111, want111);
    });
    const got112 = h.doc.listenerCount('click');
    const want112 = 0;
    it('the listeners came off with the same capture flag', () => {
      assert.deepStrictEqual(got112, want112);
    });
  }

  {
    const h = await bootedPanel();
    h.resize(260);
    click(h.ctxChipEl);

    // A click inside the popover must not close it: people select the text in
    // there.
    h.doc.fire('click', { target: h.root.querySelector('#tva-ctx-symbol') });
    const got113 = h.ctxPopEl.classList.contains('tva-hidden');
    const want113 = false;
    it('a click inside the popover does not close it', () => {
      assert.deepStrictEqual(got113, want113);
    });

    h.doc.fire('click', { target: h.ctxLabelEl });
    const got114 = h.ctxPopEl.classList.contains('tva-hidden');
    const want114 = false;
    it('a click on the chip label does not close it either', () => {
      assert.deepStrictEqual(got114, want114);
    });

    h.doc.fire('click', { target: h.listEl });
    const got115 = h.ctxPopEl.classList.contains('tva-hidden');
    const want115 = true;
    it('a click outside closes it', () => {
      assert.deepStrictEqual(got115, want115);
    });
    const got116 = [h.doc.listenerCount('click'), h.doc.listenerCount('keydown')];
    const want116 = [0, 0];
    it('and removes both document listeners', () => {
      assert.deepStrictEqual(got116, want116);
    });
  }
});

describe('the chart changes under the panel', async () => {
  {
    const h = await bootedPanel({
      caps: caps({ symbol: 'BTCUSD', resolution: '60', series: false }),
    });
    const got117 = h.bridge.listenerCount('chart-changed');
    const want117 = 1;
    it('the panel subscribed to the driver’s pushes', () => {
      assert.deepStrictEqual(got117, want117);
    });
    const got118 = h.agent.capabilities.symbol;
    const want118 = 'BTCUSD';
    it('the agent starts on the boot report', () => {
      assert.deepStrictEqual(got118, want118);
    });

    const before = h.agent.capabilities;
    h.bridge.pushChart(caps({ symbol: 'NASDAQ:AAPL', resolution: 'D', series: true }));

    const got119 = h.contextEl.textContent;
    const want119 = 'NASDAQ:AAPL · 1D';
    it('the context row followed the change', () => {
      assert.deepStrictEqual(got119, want119);
    });
    // In place, not replaced: the agent was handed this exact object at boot.
    const got120 = h.agent.capabilities.symbol;
    const want120 = 'NASDAQ:AAPL';
    it('the agent sees the new symbol', () => {
      assert.deepStrictEqual(got120, want120);
    });
    const got121 = h.agent.capabilities === before;
    const want121 = true;
    it('through the same object it was given', () => {
      assert.deepStrictEqual(got121, want121);
    });
    const got122 = h.agent.capabilities.series;
    const want122 = true;
    it('and a tool that came back is available again', () => {
      assert.deepStrictEqual(got122, want122);
    });
  }

  {
    // price is absent from the report until the new symbol's bars load; it must
    // not be carried over from the old one.
    const h = await bootedPanel({
      caps: caps({ symbol: 'BTCUSD', resolution: '60', series: true, price: 65000 }),
    });
    const got123 = h.contextEl.textContent;
    const want123 = `BTCUSD · 1h · ${fmtPrice(65000, 2)}`;
    it('the boot price is on the row', () => {
      assert.deepStrictEqual(got123, want123);
    });

    h.bridge.pushChart(caps({ symbol: 'NASDAQ:AAPL', resolution: 'D', series: false }));

    const got124 = h.agent.capabilities.symbol;
    const want124 = 'NASDAQ:AAPL';
    it('the new symbol is shown', () => {
      assert.deepStrictEqual(got124, want124);
    });
    const got125 = h.agent.capabilities.price;
    const want125 = undefined;
    it('the old price did not come with it', () => {
      assert.deepStrictEqual(got125, want125);
    });
    const got126 = h.contextEl.textContent;
    const want126 = 'NASDAQ:AAPL · 1D';
    it('and the row shows no price rather than the wrong one', () => {
      assert.deepStrictEqual(got126, want126);
    });
  }
});

describe('the model chip', async () => {
  {
    const h = await bootedPanel();
    // The label comes from the shared catalog.
    h.settings.lastOnChange({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    const got127 = h.root.querySelector('#tva-model-chip').textContent;
    const want127 = 'Claude Haiku';
    it('a catalog model gets its brand name', () => {
      assert.deepStrictEqual(got127, want127);
    });

    h.settings.lastOnChange({ provider: 'openai', model: 'gemma4:26b-a4b-it-qat' });
    const got128 = h.root.querySelector('#tva-model-chip').textContent;
    const want128 = 'gemma4:26b-a4b-it-qat';
    it('another provider’s model is written as typed', () => {
      assert.deepStrictEqual(got128, want128);
    });

    h.settings.lastOnChange({ provider: 'openai', model: '' });
    const got129 = h.root.querySelector('#tva-model-chip').textContent;
    const want129 = 'Pick a model';
    it('and with none chosen it says so', () => {
      assert.deepStrictEqual(got129, want129);
    });
  }
});
