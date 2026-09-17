/**
 * Runs the real panel.js under the fake DOM, with TVAgentMount,
 * TVAgentSettings, TVAgentBridge, TVAgentRuntime and TVAgentChat faked at
 * their interfaces.
 */
import { check, section, report } from './helpers/check.mjs';
import { makeDocument, makeElement, click, fireInput, fireKeydown } from './helpers/dom.mjs';
import { readSource } from './helpers/load.mjs';

const src = readSource('content/panel.js');

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

function load({ mount, settings, bridge, runtime, chat }) {
  const win = {};
  const doc = makeDocument();
  // The shared model catalog, loaded ahead of panel.js as the manifest loads
  // it.
  new Function('globalThis', 'window', readSource('shared/models.js'))(win, win);
  win.TVAgentChat = chat || makeChatModule(doc);
  win.TVAgentMount = mount;
  win.TVAgentSettings = settings;
  win.TVAgentBridge = bridge;
  win.TVAgentRuntime = runtime;
  const ro = makeResizeObserverStub();
  win.ResizeObserver = ro.ctor;
  const chr = makeChrome();
  new Function('window', 'document', 'chrome', src)(win, doc, chr);
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

  const { win, doc, chrome, ro } = load({ mount, settings, bridge, runtime, chat: overrides.chat });
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
section('boot: mount before build');

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

  load({ mount, settings, bridge, runtime });

  check('mount() is called once, straight away', mountCalls, 1);
  check('build() has not run — root is empty until mount() resolves', root.children.length, 0);

  resolveMount({ root, mode: 'overlay' });
  await flush();
  check(
    'once mount() resolves, build() has run and the header is there',
    root.children.length > 0,
    true,
  );
  check('the header went in as a header', root.querySelector('.tva-header') !== null, true);
}

section('boot: settings.ready decides whether the settings screen opens');

{
  const h = await bootedPanel({ settingsOpts: { ready: false } });
  check(
    'ready=false: the settings screen is open',
    h.settingsEl.classList.contains('tva-hidden'),
    false,
  );
  check('ready=false: the list is hidden', h.listEl.classList.contains('tva-hidden'), true);
  check('ready=false: the composer is hidden', h.composerEl.classList.contains('tva-hidden'), true);
  check(
    'ready=false: the empty state is hidden — we are in settings',
    h.emptyEl.classList.contains('tva-hidden'),
    true,
  );
}

{
  const h = await bootedPanel({ settingsOpts: { ready: true } });
  check(
    'ready=true: the settings screen stays closed',
    h.settingsEl.classList.contains('tva-hidden'),
    true,
  );
  check('ready=true: the list is visible', h.listEl.classList.contains('tva-hidden'), false);
  check(
    'ready=true: the composer is visible',
    h.composerEl.classList.contains('tva-hidden'),
    false,
  );
}

section('boot: a failed probe shows an error and creates no Agent');

{
  const h = await bootedPanel({ caps: caps({ tradingViewApi: false, chart: false }) });
  check('no Agent was created', h.runtime.instances.length, 0);
  check('the status is an error', h.statusEl.className, 'tva-status err');

  const errCall = h.listEl.querySelector('.tva-msg.error');
  check('an error message appeared in the list', errCall !== null, true);
  check(
    'the message names the TradingView API and /chart/',
    errCall.textContent.includes('Could not reach the TradingView API'),
    true,
  );
}

section('boot: a successful probe creates an Agent');

{
  const h = await bootedPanel({ caps: caps({ loggedIn: true }) });
  check('exactly one Agent was created', h.runtime.instances.length, 1);
  check('the status is connected', h.statusEl.className, 'tva-status ok');
}

{
  const h = await bootedPanel({ caps: caps({ loggedIn: false }) });
  check(
    'an Agent is still created when loggedIn is false — that is a status, not a blocker',
    h.runtime.instances.length,
    1,
  );
  check('the status is logged out', h.statusEl.className, 'tva-status warn');
}

// ============================================================================
section('boot: each of the four failure points shows an error rather than nothing');
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

  const { doc } = load({ mount, settings, bridge, runtime });
  await flush();
  await flush();

  const banner = doc.documentElement.querySelector('#tva-boot-error');
  check('an error banner appeared straight on documentElement', banner !== null, true);
  check('the banner names the cause', (banner?.textContent || '').includes('mount blew up'), true);
  check('no Agent — build() never ran', runtime.instances.length, 0);
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

  check('the status is err', h.statusEl.className, 'tva-status err');
  check('no Agent was created', h.runtime.instances.length, 0);
  const errCall = h.listEl.querySelector('.tva-msg.error');
  check('the error message is in the list', errCall !== null, true);
  check(
    'the message names the cause',
    (errCall?.textContent || '').includes('probe rejected'),
    true,
  );
}

// ============================================================================
section('context row: the price');
// The formatting formula is spelled out as panel.js spells it, so the test
// does not depend on the locale's grouping character.
function fmtPrice(n, maxDigits) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDigits,
  }).format(n);
}

{
  const h = await bootedPanel({
    caps: caps({ symbol: 'BTCUSDT', resolution: '240', price: 121480 }),
  });
  const expected = `BTCUSDT · 4h · ${fmtPrice(121480, 2)}`;
  check('context row: symbol · timeframe · price', h.contextEl.textContent, expected);
}

{
  // The report has no price, exactly as the real probe leaves it until the
  // bars have loaded. The context row must not draw a spare separator or the
  // word "undefined".
  const h = await bootedPanel({ caps: caps({ symbol: 'BTCUSDT', resolution: '240' }) });
  check(
    'with no price: symbol and timeframe, no dangling separator',
    h.contextEl.textContent,
    'BTCUSDT · 4h',
  );
}

{
  // An instrument under $1: two decimals would round it to 0.00.
  const h = await bootedPanel({
    caps: caps({ symbol: 'PEPEUSDT', resolution: '60', price: 0.0004567 }),
  });
  const expected = `PEPEUSDT · 1h · ${fmtPrice(0.0004567, 6)}`;
  check(
    'a sub-dollar price is not rounded to 0.00 — six decimals',
    h.contextEl.textContent,
    expected,
  );
  check('the real value is on screen, not 0.00', h.contextEl.textContent.includes('0.00 '), false);
}

{
  // The chip names what travels in the system prompt: the symbol and the
  // timeframe, not the price.
  const h = await bootedPanel({
    caps: caps({ symbol: 'BTCUSDT', resolution: '240', price: 121480 }),
  });
  check(
    'the chip names the symbol and the timeframe only',
    h.ctxLabelEl.textContent,
    'BTCUSDT · 4h in context',
  );
  check(
    'the price is not in the chip label',
    h.ctxLabelEl.textContent.includes(fmtPrice(121480, 2)),
    false,
  );
  check(
    'but the chip title carries the whole line',
    h.ctxChipEl.attrs.title,
    `BTCUSDT · 4h · ${fmtPrice(121480, 2)}`,
  );
}

// ============================================================================
section('the timeframe is written for a reader, not as a TradingView resolution');

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
    check(`${raw} → ${want}`, h.contextEl.textContent, `BTCUSDT · ${want}`);
  }

  const h = await bootedPanel({ caps: caps({ symbol: 'BTCUSDT', resolution: '' }) });
  check('an empty timeframe leaves no dangling separator', h.contextEl.textContent, 'BTCUSDT');
}

// ============================================================================
section('onActive: registered only in native mode, and focuses the input');

{
  const h = await bootedPanel({ mode: 'native' });
  check('in native mode onActive is registered', h.mount.handlers.length, 1);

  const handler = h.mount.handlers[0];
  check('focus() has not been called yet', h.inputEl._focusCount, 0);
  handler(true);
  check('active=true focuses the input', h.inputEl._focusCount, 1);
  handler(false);
  check('active=false does not focus again', h.inputEl._focusCount, 1);
}

{
  const h = await bootedPanel({ mode: 'overlay' });
  check('in overlay mode onActive is NOT registered', h.mount.handlers.length, 0);
}

// ============================================================================
section('send: empty and whitespace input is not sent');

{
  const h = await bootedPanel();
  h.inputEl.value = '';
  fireInput(h.inputEl);
  click(h.sendBtn);
  check('empty input: agent.send was not called', h.agent.sendCalls, []);
}

section('send: disclosure and provider configuration are a hard gate');

{
  const h = await bootedPanel({ settingsOpts: { ready: false } });
  // The settings screen opens at boot; closing it must not let a message
  // through.
  click(h.root.querySelector('#tva-gear'));
  check(
    'the chat can be reopened before setup is complete',
    h.settingsEl.classList.contains('tva-hidden'),
    true,
  );

  h.inputEl.value = 'read my chart';
  fireInput(h.inputEl);
  click(h.sendBtn);

  check('an unready configuration sends nothing to the model', h.agent.sendCalls, []);
  check('the user message is not added as though a run started', h.listEl.children.length, 0);
  check(
    'the settings screen reopens at the missing disclosure or permission',
    h.settingsEl.classList.contains('tva-hidden'),
    false,
  );
}

{
  const h = await bootedPanel();
  h.inputEl.value = '   \n  ';
  fireInput(h.inputEl);
  click(h.sendBtn);
  check('whitespace only: agent.send was not called', h.agent.sendCalls, []);
}

section('send: the button is disabled with no text and enabled with some');

{
  const h = await bootedPanel();
  check('with an empty input the button is disabled', h.sendBtn.disabled, true);

  h.inputEl.value = 'hello';
  fireInput(h.inputEl);
  check('typing enables it', h.sendBtn.disabled, false);

  h.inputEl.value = '';
  fireInput(h.inputEl);
  check('clearing disables it again', h.sendBtn.disabled, true);
}

section('send: a second send while busy does not go through');

{
  const h = await bootedPanel();
  h.inputEl.value = 'first message';
  fireInput(h.inputEl);
  click(h.sendBtn); // starts the run, busy=true

  check('the first message reached agent.send', h.agent.sendCalls, ['first message']);

  // Enter always calls submit(), which is where the busy guard lives; the
  // button cancels during a run instead.
  h.inputEl.value = 'second message while busy';
  fireInput(h.inputEl);
  fireKeydown(h.inputEl, { key: 'Enter' });
  check('a second send during a run does not go through', h.agent.sendCalls, ['first message']);
}

// ============================================================================
section('run lifecycle: startRun/endRun');

{
  const h = await bootedPanel();
  h.inputEl.value = 'go';
  fireInput(h.inputEl);
  click(h.sendBtn);

  check('startRun: the button took the stop class', h.sendBtn.classList.contains('stop'), true);
  check('startRun: aria-label — Stop', h.sendBtn.attrs['aria-label'], 'Stop');
  check('startRun: submit() cleared the input', h.inputEl.value, '');
  check('startRun: the button is enabled even with an empty input', h.sendBtn.disabled, false);
  check('startRun: the status is working…', h.statusEl.className, 'tva-status warn');

  // endRun recomputes `disabled` from the current input, which may have
  // changed during the run.
  h.inputEl.value = 'draft typed while agent was working';
  h.agent.handlers.onDone({ stopReason: 'end_turn' });

  check('endRun: the stop class is gone', h.sendBtn.classList.contains('stop'), false);
  check('endRun: aria-label — Send', h.sendBtn.attrs['aria-label'], 'Send');
  check(
    'endRun: disabled was recomputed from the current, non-empty input',
    h.sendBtn.disabled,
    false,
  );
  check('endRun: the status is connected', h.statusEl.className, 'tva-status ok');
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
  check('onError moves the status to err', h.statusEl.className, 'tva-status err');
  check(
    'onError shows the error text in the chat',
    h.listEl.querySelector('.tva-msg.error').textContent,
    'boom',
  );
  check(
    'onError also drops the stop class — the run is over',
    h.sendBtn.classList.contains('stop'),
    false,
  );
}

section('run lifecycle: the Stop button cancels rather than sends');

{
  const h = await bootedPanel();
  h.inputEl.value = 'go';
  fireInput(h.inputEl);
  click(h.sendBtn); // the run starts, busy=true

  h.inputEl.value = 'this must not be sent';
  fireInput(h.inputEl);
  click(h.sendBtn); // during a run the same button is Stop

  check('a second click during a run calls agent.cancel()', h.agent.cancelCalls, 1);
  check('a second click during a run adds no new send', h.agent.sendCalls, ['go']);
}

// ============================================================================
section('suggestions: a click sends straight away rather than filling the box');

{
  const h = await bootedPanel();
  const card = h.root.querySelector('.tva-suggestion');
  check('the suggestion card is there', card !== null, true);

  check('the input is empty before the click', h.inputEl.value, '');
  click(card);

  check('clicking a suggestion sends its text straight away', h.agent.sendCalls, [
    'What am I looking at?',
  ]);
  check('the input is NOT filled with it — deliberate, not a filled field', h.inputEl.value, '');
}

// ============================================================================
section('screens: showScreen(settings) hides the list and the composer');

{
  const h = await bootedPanel();
  click(h.root.querySelector('#tva-gear'));

  check('settings is open', h.settingsEl.classList.contains('tva-hidden'), false);
  check('the list is hidden', h.listEl.classList.contains('tva-hidden'), true);
  check('the composer is hidden', h.composerEl.classList.contains('tva-hidden'), true);
  check(
    'the empty state is hidden — we are in settings',
    h.emptyEl.classList.contains('tva-hidden'),
    true,
  );
  check('settings.refresh() was called on opening', h.settings.refreshCalls, 1);
}

section('screens: going back restores the list and the composer');

{
  const h = await bootedPanel();
  click(h.root.querySelector('#tva-gear')); // open
  click(h.root.querySelector('#tva-gear')); // close

  check('settings closed again', h.settingsEl.classList.contains('tva-hidden'), true);
  check('the list is visible again', h.listEl.classList.contains('tva-hidden'), false);
  check('the composer is visible again', h.composerEl.classList.contains('tva-hidden'), false);
}

section('screens: the empty state shows only when the list is empty and we are not in settings');

{
  const h = await bootedPanel();
  check(
    'the list starts empty, so the empty state shows',
    h.emptyEl.classList.contains('tva-hidden'),
    false,
  );
}

section('screens: submit() — the first message hides the empty state at once');
{
  // The message has to be appended before showScreen() recomputes the empty
  // state, or the placeholder sits next to the first message.
  const h = await bootedPanel();
  h.inputEl.value = 'first ever message';
  fireInput(h.inputEl);
  click(h.sendBtn);

  check('after the first message the list is no longer empty', h.listEl.children.length > 0, true);
  check(
    'the first message hides the empty state at once',
    h.emptyEl.classList.contains('tva-hidden'),
    true,
  );

  h.inputEl.value = 'second message';
  fireInput(h.inputEl);
  h.agent.handlers.onDone({}); // release busy, or the second submit() is refused
  click(h.sendBtn);
  check('and it stays hidden on the second', h.emptyEl.classList.contains('tva-hidden'), true);
}

// ============================================================================
section('New chat resets the agent, clears the list, and the empty state returns');

{
  const h = await bootedPanel();
  const dummy = h.doc.createElement('div');
  dummy.className = 'tva-msg user';
  h.listEl.appendChild(dummy);
  h.emptyEl.classList.add('tva-hidden');

  click(h.root.querySelector('#tva-new'));

  check('New chat calls agent.reset()', h.agent.resetCalls, 1);
  check('New chat clears the list', h.listEl.children.length, 0);
  check('New chat returns to the chat screen', h.settingsEl.classList.contains('tva-hidden'), true);
  check('New chat shows the empty state again', h.emptyEl.classList.contains('tva-hidden'), false);
}

section('narrow panel: the class comes from the panel’s own width');

{
  const h = await bootedPanel({
    caps: caps({ symbol: 'BINGX:BTCUSDT.P', resolution: '240', price: 64446.7 }),
  });

  // Compared by reference, not by JSON: the fake DOM's nodes point back at
  // their parent and serialising one would cycle.
  check('the ResizeObserver watches exactly one node', h.ro.observed.length, 1);
  check('and it is the panel root', h.ro.observed[0] === h.root, true);
  check(
    'before the first measurement the panel counts as wide',
    h.root.classList.contains('tva-narrow'),
    false,
  );

  h.resize(280);
  check('280px is narrow', h.root.classList.contains('tva-narrow'), true);

  h.resize(400);
  check('400px is wide again', h.root.classList.contains('tva-narrow'), false);

  // A hidden panel measures 0. That is "not rendered", not "narrow".
  h.resize(0);
  check('a zero width changes nothing', h.root.classList.contains('tva-narrow'), false);

  // The threshold is shared with panel.css's narrow section: 320px inclusive.
  h.resize(320);
  check('exactly 320px is narrow', h.root.classList.contains('tva-narrow'), true);
  h.resize(321);
  check('321px is wide', h.root.classList.contains('tva-narrow'), false);

  // A real ResizeObserver delivers a batch of entries; the last one is current.
  h.resize(400, 260);
  check(
    'the last entry in the batch wins, not the first',
    h.root.classList.contains('tva-narrow'),
    true,
  );
}

// ============================================================================
section('narrow panel: the status and the context chip');

{
  const h = await bootedPanel({
    caps: caps({ symbol: 'BINGX:BTCUSDT.P', resolution: '240', price: 64446.7 }),
  });
  const full = `BINGX:BTCUSDT.P · 4h · ${fmtPrice(64446.7, 2)}`;

  // CSS hides the word when narrow; the text stays in the DOM and in the
  // title.
  check(
    'the status word stays in the DOM',
    h.statusEl.querySelector('span').textContent,
    'connected',
  );
  check('the status carries a title, which is what CSS hides', h.statusEl.attrs.title, 'connected');

  check('the context row has the whole line as its title', h.contextEl.attrs.title, full);
  check(
    'wide: the chip shows symbol and timeframe',
    h.ctxLabelEl.textContent,
    'BINGX:BTCUSDT.P · 4h in context',
  );

  h.resize(260);
  check(
    'narrow: the chip shows the ticker only, no exchange',
    h.ctxLabelEl.textContent,
    'BTCUSDT.P',
  );
  check('the chip title is still the whole line', h.ctxChipEl.attrs.title, full);

  h.resize(400);
  check(
    'back at wide: symbol and timeframe again',
    h.ctxLabelEl.textContent,
    'BINGX:BTCUSDT.P · 4h in context',
  );
}

{
  const h = await bootedPanel({ caps: caps({ symbol: '', resolution: '' }) });
  check(
    'with no symbol the context chip is hidden entirely',
    h.ctxChipEl.classList.contains('tva-hidden'),
    true,
  );
}

// ============================================================================
section('the context popover');

{
  const h = await bootedPanel({
    caps: caps({ symbol: 'BINGX:BTCUSDT.P', resolution: '240', price: 64446.7 }),
  });

  check(
    'the symbol row is filled in',
    h.root.querySelector('#tva-ctx-symbol').textContent,
    'BINGX:BTCUSDT.P',
  );
  check(
    'the timeframe row is filled in for a reader',
    h.root.querySelector('#tva-ctx-resolution').textContent,
    '4h',
  );
  check(
    'the price row is formatted as in the row above',
    h.root.querySelector('#tva-ctx-price').textContent,
    fmtPrice(64446.7, 2),
  );

  // When wide the whole line is already visible — there is nothing to open.
  click(h.ctxChipEl);
  check(
    'when wide, clicking the chip opens nothing',
    h.ctxPopEl.classList.contains('tva-hidden'),
    true,
  );
  check('and binds no document listeners', h.doc.listenerCount('click'), 0);

  h.resize(260);
  click(h.ctxChipEl);
  check(
    'when narrow, a click opens the popover',
    h.ctxPopEl.classList.contains('tva-hidden'),
    false,
  );
  check('aria-expanded=true', h.ctxChipEl.attrs['aria-expanded'], 'true');

  click(h.ctxChipEl);
  check('a second click closes it', h.ctxPopEl.classList.contains('tva-hidden'), true);
  check('aria-expanded=false', h.ctxChipEl.attrs['aria-expanded'], 'false');
  check('the listeners came off with the same capture flag', h.doc.listenerCount('click'), 0);
}

{
  const h = await bootedPanel();
  h.resize(260);
  click(h.ctxChipEl);

  // A click inside the popover must not close it: people select the text in
  // there.
  h.doc.fire('click', { target: h.root.querySelector('#tva-ctx-symbol') });
  check(
    'a click inside the popover does not close it',
    h.ctxPopEl.classList.contains('tva-hidden'),
    false,
  );

  h.doc.fire('click', { target: h.ctxLabelEl });
  check(
    'a click on the chip label does not close it either',
    h.ctxPopEl.classList.contains('tva-hidden'),
    false,
  );

  h.doc.fire('click', { target: h.listEl });
  check('a click outside closes it', h.ctxPopEl.classList.contains('tva-hidden'), true);
  check(
    'and removes both document listeners',
    [h.doc.listenerCount('click'), h.doc.listenerCount('keydown')],
    [0, 0],
  );
}

section('the chart changes under the panel');

{
  const h = await bootedPanel({
    caps: caps({ symbol: 'BTCUSD', resolution: '60', series: false }),
  });
  check('the panel subscribed to the driver’s pushes', h.bridge.listenerCount('chart-changed'), 1);
  check('the agent starts on the boot report', h.agent.capabilities.symbol, 'BTCUSD');

  const before = h.agent.capabilities;
  h.bridge.pushChart(caps({ symbol: 'NASDAQ:AAPL', resolution: 'D', series: true }));

  check('the context row followed the change', h.contextEl.textContent, 'NASDAQ:AAPL · 1D');
  // In place, not replaced: the agent was handed this exact object at boot.
  check('the agent sees the new symbol', h.agent.capabilities.symbol, 'NASDAQ:AAPL');
  check('through the same object it was given', h.agent.capabilities === before, true);
  check('and a tool that came back is available again', h.agent.capabilities.series, true);
}

{
  // price is absent from the report until the new symbol's bars load; it must
  // not be carried over from the old one.
  const h = await bootedPanel({
    caps: caps({ symbol: 'BTCUSD', resolution: '60', series: true, price: 65000 }),
  });
  check(
    'the boot price is on the row',
    h.contextEl.textContent,
    `BTCUSD · 1h · ${fmtPrice(65000, 2)}`,
  );

  h.bridge.pushChart(caps({ symbol: 'NASDAQ:AAPL', resolution: 'D', series: false }));

  check('the new symbol is shown', h.agent.capabilities.symbol, 'NASDAQ:AAPL');
  check('the old price did not come with it', h.agent.capabilities.price, undefined);
  check(
    'and the row shows no price rather than the wrong one',
    h.contextEl.textContent,
    'NASDAQ:AAPL · 1D',
  );
}

section('the model chip');

{
  const h = await bootedPanel();
  // The label comes from the shared catalog.
  h.settings.lastOnChange({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  check(
    'a catalog model gets its brand name',
    h.root.querySelector('#tva-model-chip').textContent,
    'Claude Haiku',
  );

  h.settings.lastOnChange({ provider: 'openai', model: 'gemma4:26b-a4b-it-qat' });
  check(
    'another provider’s model is written as typed',
    h.root.querySelector('#tva-model-chip').textContent,
    'gemma4:26b-a4b-it-qat',
  );

  h.settings.lastOnChange({ provider: 'openai', model: '' });
  check(
    'and with none chosen it says so',
    h.root.querySelector('#tva-model-chip').textContent,
    'Pick a model',
  );
}

report();
