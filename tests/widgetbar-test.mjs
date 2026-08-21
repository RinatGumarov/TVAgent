/**
 * TVAgent — the panel's page in TradingView's widget bar.
 *
 * Runs the real driver.js against a fake window.widgetbar. What is expensive to
 * break: activation must not go through the host's tab-click handler (that one
 * writes our page into the account's saved layout), closing has to put back the
 * tab that was there rather than move the user if they navigated away
 * themselves — and it remembers the page object for that, not an index, which
 * shifts when somebody else's page is removed.
 *
 * The fake has to hold the host's contract rather than a convenient one: three
 * times in a row a difference between the two hid a real defect. So
 * page.onActiveStateChange throws here when the page has no tab, switchPage and
 * setMinimizedState both call it, and createPage hands back a page in exactly
 * the state the host hands it back in — no tab and no name.
 *
 *   node widgetbar-test.mjs
 */
import { check, section, report } from './helpers/check.mjs';
import { readSource, settle } from './helpers/load.mjs';

const src = readSource('injected/driver.js');

/**
 * An observable with the same interface as TradingView's. With no argument it
 * behaves like a freshly constructed one — .value() === undefined, as the real
 * layout.isMinimized is until the bar first measures its own width.
 */
function watched(value) {
  const subs = [];
  return {
    value: () => value,
    setValue: (v) => {
      value = v;
      subs.slice().forEach((fn) => fn(v));
    },
    subscribe: (fn) => subs.push(fn),
    // unsubscribe(cb) drops every matching listener; with no argument, all.
    unsubscribe: (fn) => {
      if (!fn) {
        subs.length = 0;
        return;
      }
      for (let i = subs.length; i--;) if (subs[i] === fn) subs.splice(i, 1);
    },
    // Test-only: how many subscribers are attached right now.
    count: () => subs.length,
  };
}

// ------------------------------------------------------------------ DOM

/**
 * The MutationObservers alive in this run. A real one batches its callback
 * into a microtask; this one calls it synchronously, which is stricter — if
 * the driver's own button insertion provokes another insertion, the test
 * overflows the stack rather than spreading it quietly across ticks.
 */
const mutationObservers = [];
function notifyObservers(target) {
  mutationObservers.slice().forEach((o) => {
    if (!o.connected || o.target !== target) return;
    o.calls++;
    o.cb([], o);
  });
}

/**
 * The selectors the driver is allowed to ask for. Anything else is an error:
 * the fake must not quietly guess at the meaning of a new one and leave checks
 * green that no longer mean anything.
 */
const BUTTON_SELECTORS = [
  'button[data-name][aria-pressed="false"]:not(:disabled)',
  'button[data-name]:not(:disabled)',
];
const DOCUMENT_SELECTORS = ['.widgetbar-pagescontent', '[data-name="right-toolbar"]'];

function unknownSelector(sel, known) {
  return new Error(
    `the fake does not know the selector ${JSON.stringify(sel)} (it knows ${known.join(', ')}) — ` +
      'update it deliberately, alongside the driver'
  );
}

/**
 * A minimal node. querySelector understands exactly the selectors the driver
 * uses — there is no general CSS engine here, and none is needed.
 */
function node(tag, attrs = {}) {
  const e = {
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    classes: new Set(),
    children: [],
    listeners: {},
    parent: null,
    className: '',
    textContent: '',
    id: '',
    setAttribute: (k, v) => { e.attrs[k] = String(v); },
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
    classList: {
      add: (c) => e.classes.add(c),
      remove: (c) => e.classes.delete(c),
      toggle: (c, on) => (on ? e.classes.add(c) : e.classes.delete(c)),
    },
    appendChild(child) {
      child.parent = e;
      e.children.push(child);
      notifyObservers(e);
      return child;
    },
    insertBefore(child, anchor) {
      const i = anchor ? e.children.indexOf(anchor) : -1;
      child.parent = e;
      if (i === -1) e.children.push(child);
      else e.children.splice(i, 0, child);
      notifyObservers(e);
      return child;
    },
    remove() {
      if (!e.parent) return;
      const parent = e.parent;
      const i = parent.children.indexOf(e);
      if (i !== -1) parent.children.splice(i, 1);
      e.parent = null;
      notifyObservers(parent);
    },
    contains(n) {
      for (let p = n; p; p = p.parent) if (p === e) return true;
      return false;
    },
    // cloneNode(false) copies attributes and classes, not children or listeners.
    cloneNode: () => {
      const copy = node(tag, e.attrs);
      e.classes.forEach((c) => copy.classes.add(c));
      return copy;
    },
    addEventListener(type, fn) {
      (e.listeners[type] = e.listeners[type] || []).push(fn);
    },
    fire(type) {
      (e.listeners[type] || []).forEach((fn) => fn({}));
    },
    querySelector(sel) {
      if (!BUTTON_SELECTORS.includes(sel)) throw unknownSelector(sel, BUTTON_SELECTORS);
      const wantPressedFalse = sel.includes('aria-pressed="false"');
      const walk = (n) => {
        for (const c of n.children) {
          const ok =
            c.tagName === 'BUTTON' &&
            'data-name' in c.attrs &&
            !('disabled' in c.attrs) &&
            (!wantPressedFalse || c.attrs['aria-pressed'] === 'false');
          if (ok) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      return walk(e);
    },
  };
  return e;
}

/**
 * The right toolbar in the order TradingView renders it: the close button
 * first (only in fullscreen, and it sets no aria-pressed), then the tabs, the
 * active one carrying aria-pressed="true", then the filler — which is where
 * the top group ends.
 */
function makeToolbar({ closeButton = false, activeFirstTab = true } = {}) {
  const toolbar = node('div', { 'data-name': 'right-toolbar' });
  if (closeButton) {
    const close = node('button', { 'data-name': 'close-button' });
    close.classes.add('hash-close'); // its own theme, not ours
    toolbar.appendChild(close);
  }
  const base = node('button', {
    'data-name': 'base',
    'aria-pressed': activeFirstTab ? 'true' : 'false',
  });
  // The active state is a hashed class on the button itself: clone one of
  // those and our tab is lit for good.
  if (activeFirstTab) base.classes.add('hash-active');
  toolbar.appendChild(base);
  toolbar.appendChild(node('button', { 'data-name': 'alerts', 'aria-pressed': 'false' }));
  toolbar.appendChild(node('div', { 'data-name': 'filler' }));
  toolbar.appendChild(node('button', { 'data-name': 'below-filler', 'aria-pressed': 'false' }));
  return toolbar;
}

/** Exactly the DOM the driver needs; everything else answers null. */
function makeDocument(found = {}) {
  return {
    querySelector: (sel) => found[sel] || null,
    contains: () => true,
    createElement: () => node('span'),
  };
}

/** The full DOM: the page container and the toolbar. */
function makeFullDocument(toolbar = makeToolbar()) {
  const root = node('div');
  const content = node('div');
  content.classes.add('widgetbar-pagescontent');
  root.appendChild(content);
  root.appendChild(toolbar);
  const doc = {
    root,
    content,
    toolbar,
    querySelector: (sel) => {
      if (!DOCUMENT_SELECTORS.includes(sel)) throw unknownSelector(sel, DOCUMENT_SELECTORS);
      return sel === '.widgetbar-pagescontent' ? content : toolbar;
    },
    contains: (n) => root.contains(n),
    createElement: () => node('span'),
  };
  return doc;
}

/**
 * A complete document whose querySelector answers null until .reveal() is
 * called — which is what the browser really saw before TradingView had built
 * the widget bar: neither .widgetbar-pagescontent nor the right toolbar is in
 * the DOM yet, even though both nodes already exist as objects and appear the
 * instant .reveal() is called. `content` and `toolbar` are reachable directly,
 * bypassing querySelector, the same way the real createPage() writes into its
 * own container rather than looking one up.
 */
function makeDelayedFullDocument(toolbar = makeToolbar()) {
  const full = makeFullDocument(toolbar);
  let ready = false;
  return {
    ...full,
    querySelector: (sel) => (ready ? full.querySelector(sel) : null),
    reveal: () => { ready = true; },
  };
}

/**
 * A setTimeout that does not spend real time: it calls back almost at once
 * whatever delay is asked for. Only the "the wait budget ran out" test needs
 * it — the driver still makes all WIDGETBAR_WAIT_ATTEMPTS attempts, just
 * quickly.
 */
function instantTimer(fn) {
  setTimeout(fn, 0);
}

// ------------------------------------------------------------------ layout

/**
 * A page in the state the host hands it back in. onActiveStateChange asserts
 * that the tab exists and throws when it does not — which is exactly how the
 * host wedges the whole widget bar on a page without one.
 */
function makePage(name) {
  const page = {
    name,
    widgets: [],
    tab: undefined,
    active: false,
    el: null,
    element: () => page.el,
    onActiveStateChange(state) {
      if (!page.tab) throw new Error('Value is undefined'); // the host's own assertion
      page.tab.onActiveStateChange(!!state);
      page.active = !!state;
    },
  };
  return page;
}

/** A native page comes back from the saved layout — so it already has a tab. */
function makeNativePage(name) {
  const page = makePage(name);
  page.tab = { onActiveStateChange() {}, updateNotifications() {} };
  return page;
}

/**
 * The fake layout. switchPage and setMinimizedState behave like the real
 * ones — in particular setMinimizedState says nothing when the value has not
 * changed — and onTabClick only records that it was called, because the driver
 * must never reach it.
 */
function makeLayout(pageCount = 3, doc = null) {
  const pages = Array.from({ length: pageCount }, (_, i) => makeNativePage(`native_${i}`));
  const L = {
    pages,
    activeIndex: 1,
    activeName: pageCount > 1 ? 'native_1' : '',
    activePageIndex: watched(1),
    isMinimized: watched(false),
    calls: [],
    // A page with no tab and no name; its element goes into the layout's own
    // container.
    createPage() {
      const page = makePage(undefined);
      page.el = doc ? doc.createElement('div') : null;
      if (doc && page.el) doc.content.appendChild(page.el);
      pages.push(page);
      L.calls.push('createPage');
      return page;
    },
    // Takes either an index or a page object, and quietly does nothing for a
    // detached page (pages.indexOf === -1). The order matters: activePageIndex
    // is updated BEFORE onActiveStateChange, so a subscriber sees the new
    // index while the host can still throw.
    switchPage(pageOrIndex) {
      if (pageOrIndex === -1 || pages.length === 0) {
        L.activeIndex = -1;
        L.activePageIndex.setValue(-1);
        return;
      }
      let index = pageOrIndex;
      if (typeof pageOrIndex !== 'number') {
        index = pages.indexOf(pageOrIndex);
        if (index === -1) return;
      }
      const prevPage = pages[L.activeIndex];
      L.activeIndex = Math.min(pages.length - 1, Math.max(0, index));
      L.calls.push(`switchPage:${L.activeIndex}`);
      L.activePageIndex.setValue(L.activeIndex);
      const newPage = pages[L.activeIndex];
      L.activeName = newPage.name || '';
      if (L.isMinimized.value()) return;
      if (prevPage && prevPage === newPage) return;
      if (prevPage) prevPage.onActiveStateChange(false);
      if (newPage) {
        newPage.onActiveStateChange(true);
      }
    },
    // The real host also keeps a plain `minimized` field, but it only differs
    // from the observable before the first call — and the "isMinimized is
    // still undefined" test rests on the observable.
    setMinimizedState(v) {
      const value = !!v;
      if (L.isMinimized.value() === value) return;
      L.calls.push(`minimize:${value}`);
      L.isMinimized.setValue(value);
      if (L.activeIndex >= 0) pages[L.activeIndex].onActiveStateChange(!value);
    },
    removePage(p) {
      const i = pages.indexOf(p);
      if (i === -1) return;
      pages.splice(i, 1);
      p.element()?.remove();
      L.calls.push('removePage');
      // The host only fixes up "the active page was removed": switchPage(i-1).
      // Removing a page BEFORE the active one is not compensated for.
      if (i === L.activeIndex) L.switchPage(i - 1);
    },
    onTabClick() {
      L.calls.push('onTabClick');
    },
  };
  return L;
}

function load({ layout, document: doc = makeDocument(), isAuthenticated = false, setTimeoutImpl }) {
  const posted = [];
  const listeners = {};
  mutationObservers.length = 0;
  const observers = mutationObservers;
  const win = {
    location: { origin: 'https://www.tradingview.com' },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    postMessage: (m) => posted.push(m),
    // The wire's handshake mints ids and an HMAC key at load; the driver does
    // that before anything here runs.
    crypto: globalThis.crypto,
    TradingViewApi: {},
    widgetbar: layout ? { layout } : undefined,
    // TradingView only builds a widget bar when this flag is set, and the
    // driver's waitForWidgetBar reads it to tell "not yet" from "never".
    is_authenticated: isAuthenticated,
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.target = null;
        this.connected = false;
        this.calls = 0;
        observers.push(this);
      }
      observe(target) {
        this.target = target;
        this.connected = true;
      }
      disconnect() {
        this.connected = false;
      }
    },
  };
  // The debug export the driver hangs off `window` is behind the debug flag,
  // so a page that never asks for it never gets a way past the stamped bridge.
  // The tests are the other caller, and they turn it on the same way a person
  // would.
  const localStorage = { getItem: (k) => (k === 'tv-agent-debug' ? '1' : null) };

  // The manifest loads these two into the page world ahead of the driver, and
  // the driver reads both at the top of its IIFE.
  for (const rel of ['shared/wire.js', 'shared/wait.js']) {
    new Function('globalThis', 'window', readSource(rel))(win, win);
  }

  // setTimeout is its own sandbox parameter rather than a property of win,
  // because the driver calls it as a bare identifier. Only the exhausted-budget
  // test substitutes one; everything else gets the real timer.
  new Function(
    'window',
    'document',
    'localStorage',
    'performance',
    'setTimeout',
    src
  )(win, doc, localStorage, { now: () => 0 }, setTimeoutImpl || setTimeout);
  // __adopt hangs off the debug export, not HANDLERS — it must not be reachable
  // by posting a tva-req from a page script.
  return {
    call: win.__tvAgent.call,
    adopt: win.__tvAgent.__adopt,
    posted,
    win,
    observers,
    fire: (type) => (listeners[type] || []).forEach((fn) => fn({})),
    listenerCount: (type) => (listeners[type] || []).length,
  };
}

/** The handlers are synchronous, so they throw synchronously — .catch() would miss it. */
async function failure(fn) {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
}

section('mounting');

{
  const { call } = load({ layout: null });
  const err = await failure(() => call('widgetbar_mount'));
  check('with no window.widgetbar, mounting refuses', /widget bar/i.test(err), true);
}

{
  // The bar and the toolbar are already there: this is a downstream failure
  // inside wbMount, not the race for the bar, so both are present up front.
  const L = makeLayout();
  const doc = makeDocument({ '[data-name="right-toolbar"]': makeToolbar() });
  const { call } = load({ layout: L, document: doc });
  const err = await failure(() => call('widgetbar_mount'));
  check('with no page container, mounting refuses', /page container/i.test(err), true);
  check('no page was created', L.calls, []);
}

{
  // The hide_right_toolbar_tabs featureset renders no toolbar at all and
  // never will: that is a build flag, not a loading race. waitForWidgetBar
  // cannot — and should not — tell a permanent absence from a slow load, so it
  // waits out the whole budget before refusing. createPage() is never reached
  // this time (waitForWidgetBar throws before layout() is called), so there is
  // no orphaned page to roll back.
  const doc = makeFullDocument();
  doc.querySelector = (sel) => (sel === '.widgetbar-pagescontent' ? doc.content : null);
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc, isAuthenticated: true, setTimeoutImpl: instantTimer });
  const err = await failure(() => call('widgetbar_mount'));
  check('with no toolbar, mounting refuses on the timeout', /timed out/i.test(err), true);
  check('no page was created at all', L.calls, []);
  check('no page element appeared in the DOM', doc.content.children.length, 0);
}

{
  // waitForWidgetBar and injectButton ask for the same selector twice with no
  // await between them, so today nothing can slip in. The check inside
  // injectButton is not decoration all the same: if a refactor ever puts an
  // await between the wait and createPage, the rollback has to work exactly as
  // it did for hide_right_toolbar_tabs. This fakes that gap — the toolbar is
  // there for the first query (readiness) and gone for the second.
  const doc = makeFullDocument();
  const realQuerySelector = doc.querySelector;
  let toolbarQueries = 0;
  doc.querySelector = (sel) => {
    if (sel === '[data-name="right-toolbar"]') {
      toolbarQueries++;
      return toolbarQueries === 1 ? doc.toolbar : null;
    }
    return realQuerySelector(sel);
  };
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  const err = await failure(() => call('widgetbar_mount'));
  check('the toolbar vanished between readiness and injectButton: refused', /toolbar/i.test(err), true);
  check('the page was rolled back', L.pages.length, 3);
  check('and its element removed from the DOM', doc.content.children.length, 0);
}

{
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  const res = await call('widgetbar_mount');
  check('mounting hands back the page id', res, { ok: true, pageId: 'tva-widgetbar-page' });
  check('the page was added', L.pages.length, 4);

  const page = L.pages[3];
  check('the page has a tab', Boolean(page.tab), true);
  // Not a behavioural check but a recorded assumption: the only thing that
  // suppresses a second button from the host's own tab rendering is that it
  // draws nothing for a model that is not visible. That there really is one
  // button is verified by hand on a live page, not by a fake React.
  check(
    'assumption: the tab is invisible, so there is no second button',
    [Boolean(page.tab), page.tab && page.tab.visible.value()],
    [true, false]
  );
  check(
    'the tab has no onClick — the host handler is out of reach',
    [Boolean(page.tab), Boolean(page.tab) && page.tab.onClick.value() === undefined],
    [true, true]
  );
  check('the page has a name', page.name, 'tva_agent');

  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  const filler = doc.toolbar.children.find((c) => c.tagName !== 'BUTTON');
  check('the button went into the top group, before the filler',
    doc.toolbar.children.indexOf(btn) + 1, doc.toolbar.children.indexOf(filler));
  check('the button does not steal the toolbar tab stop', btn.attrs.tabindex, '-1');
  // `base` is the first button[data-name] in the DOM and is active by
  // default: a clone of it would carry the active-state hash and stay lit.
  check('the clone did not carry the active tab hash', btn.classes.has('hash-active'), false);
}

{
  // Adaptive fullscreen: the close button comes first in the toolbar. It has
  // no aria-pressed, and its theme is its own.
  const doc = makeFullDocument(makeToolbar({ closeButton: true }));
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  check('the close button is not used as the model', btn.classes.has('hash-close'), false);
  check('and neither is the active tab', btn.classes.has('hash-active'), false);
}

{
  // Mounting again over a live mount is a no-op.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  await call('widgetbar_mount');
  check('a second mount creates no second page', L.pages.length, 4);
  check(
    'a second mount creates no second button',
    doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length,
    1
  );
}

{
  // The element was dropped from the DOM (React re-rendered the panel). Mount
  // has to clear away what the previous one left rather than grow a second
  // page and a second button that the old observer keeps putting back.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call, observers } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  const firstButton = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  L.pages[3].el.remove(); // the element was detached
  await call('widgetbar_mount');
  check('remounting leaves no second page', L.pages.length, 4);
  check(
    'remounting leaves no second button',
    doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length,
    1
  );
  check('the old button was taken out of the toolbar', doc.toolbar.contains(firstButton), false);
  // The old observer holds the old button and would put it back.
  check('the old observer is disconnected, the new one connected', observers.map((o) => o.connected), [false, true]);
}

{
  // React re-rendered the tab list and dropped our button. The observer has
  // to put it back and then stop: a second callback sees the button in the
  // toolbar and inserts nothing more.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call, observers } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  observers[0].calls = 0;
  btn.remove();
  const filler = doc.toolbar.children.find((c) => c.tagName !== 'BUTTON');
  check('the button was put back in the toolbar', doc.toolbar.contains(btn), true);
  check('and in its old place, at the end of the top group',
    doc.toolbar.children.indexOf(btn) + 1, doc.toolbar.children.indexOf(filler));
  // One callback for the removal, one for the re-insertion, and that is all.
  check('putting it back does not loop', observers[0].calls, 2);
}

{
  // Unload uses pagehide — unlike beforeunload it works with the bfcache and
  // does not disqualify the page from it — and it is armed only after a mount.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call, fire, listenerCount } = load({ layout: L, document: doc });
  check('nothing is bound to unload before a mount', listenerCount('pagehide'), 0);
  check('beforeunload is not used at all', listenerCount('beforeunload'), 0);
  await call('widgetbar_mount');
  check('mount and activate both go through',
    await failure(() => call('widgetbar_activate')), '');
  check('the unload listener appeared with the mount', listenerCount('pagehide'), 1);
  fire('pagehide');
  check('on unload the page leaves layout.pages', L.pages.length, 3);
  check('and the user is put back on their own tab', L.activeIndex, 1);
}

{
  // The user logs in mid-session. TradingView does not patch the layout on a
  // login state change, it destroys the whole thing — taking the page
  // container with it — and installs a fresh object in its place. Our
  // subscriptions have to move with it, or the button and the panel silently
  // stop hearing about the bar's state.
  const doc = makeFullDocument();
  const L1 = makeLayout(3, doc);
  const { call, posted, win } = load({ layout: L1, document: doc });
  await call('widgetbar_mount');
  await call('widgetbar_activate');
  check('the subscriptions are on the first layout',
    [L1.activePageIndex.count(), L1.isMinimized.count()], [1, 1]);

  const L2 = makeLayout(3, doc);
  // destroy() takes the whole page container. Only one consequence matters to
  // the driver — document.contains(wb.el) turns false and mount's fast path no
  // longer fires — so that is what this reproduces.
  doc.content.children.slice().forEach((c) => c.remove());
  win.widgetbar.layout = L2;

  await call('widgetbar_mount');
  check('the page was rebuilt in the new layout', L2.pages.length, 4);
  check('the old layout was unsubscribed from',
    [L1.activePageIndex.count(), L1.isMinimized.count()], [0, 0]);
  check('and the new one subscribed to',
    [L2.activePageIndex.count(), L2.isMinimized.count()], [1, 1]);

  posted.length = 0;
  L2.switchPage(3);
  // Every event carries a stamp, and making one is asynchronous — so an emit
  // lands a microtask after the call that caused it.
  await settle();
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('the new layout drives our state again',
    [evt && evt.type, evt && evt.payload], ['widgetbar-active', { active: true }]);
}

section('the race for the bar to appear');

{
  // The bug itself: on a live page window.widgetbar — and with it the layout
  // and the toolbar — appears a second or so AFTER the driver is ready and has
  // taken its first widgetbar_mount. window.is_authenticated is set earlier,
  // but building the bar is still asynchronous. The old code threw on the
  // first miss and settled there for good; mounting has to wait it out.
  const doc = makeDelayedFullDocument();
  const L = makeLayout(3, doc);
  const { call, win } = load({ layout: null, document: doc, isAuthenticated: true });
  setTimeout(() => {
    doc.reveal();
    win.widgetbar = { layout: L };
  }, 350);
  const res = await call('widgetbar_mount');
  check('race: mounting waits for the bar rather than refusing', res, { ok: true, pageId: 'tva-widgetbar-page' });
  check('race: the page was created', L.pages.length, 4);
  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  check('race: the button went into the toolbar', Boolean(btn), true);
  check('race: the page element is in the container', doc.content.children.includes(L.pages[3].el), true);
}

{
  // While the first widgetbar_mount is parked in the poll, a second one — a
  // repeated boot call, a retry — must not run the body again: both would call
  // createPage() independently and the second would silently orphan the
  // first's page, button and observer.
  const doc = makeDelayedFullDocument();
  const L = makeLayout(3, doc);
  const { call, win } = load({ layout: null, document: doc, isAuthenticated: true });
  setTimeout(() => {
    doc.reveal();
    win.widgetbar = { layout: L };
  }, 350);
  const [res1, res2] = await Promise.all([call('widgetbar_mount'), call('widgetbar_mount')]);
  check('concurrent mounts: both resolve to one result', [res1, res2], [
    { ok: true, pageId: 'tva-widgetbar-page' },
    { ok: true, pageId: 'tva-widgetbar-page' },
  ]);
  check('concurrent mounts: only one page was created', L.pages.length, 4);
  check(
    'concurrent mounts: only one button was created',
    doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length,
    1
  );
}

{
  // An anonymous session: there will never be a bar, and that is known at
  // once because window.is_authenticated is false. The refusal has to be
  // immediate rather than spend the whole wait budget polling for nothing.
  const doc = makeDocument();
  const { call } = load({ layout: null, document: doc, isAuthenticated: false });
  const t0 = Date.now();
  const err = await failure(() => call('widgetbar_mount'));
  const elapsed = Date.now() - t0;
  check('not authenticated: refused as an anonymous session', /anonymous/i.test(err), true);
  check('not authenticated: refused at once, without polling', elapsed < 100, true);
}

{
  // Authenticated, but the bar never arrived within the budget — a real host
  // failure rather than ordinary asynchrony. The message has to say timeout: a
  // misdiagnosis of "anonymous session" would be a plain untruth told to a
  // logged-in user.
  const doc = makeDocument();
  const { call } = load({
    layout: null,
    document: doc,
    isAuthenticated: true,
    setTimeoutImpl: instantTimer,
  });
  const err = await failure(() => call('widgetbar_mount'));
  check('timeout: the message says timeout', /timed out/i.test(err), true);
  check('timeout: the message does not blame an anonymous session', /anonymous/i.test(err), false);
}

section('activation');

{
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  L.calls.length = 0;
  await call('widgetbar_activate');
  // The end state, not the call log: the real setMinimizedState says nothing
  // when the value has not changed, so the log will not always show
  // "minimize:false".
  check('we switch to our page and un-minimize', [L.activeIndex, L.isMinimized.value()], [3, false]);
  check('the host tab-click handler was never called', L.calls.includes('onTabClick'), false);
  check('the host activated our page', page.active, true);
  // switchPage writes our page's name into layout.activeName, and the next
  // save to account settings — a widget divider drag, or a drag of the bar's
  // own edge — carries it there. On the next load TradingView finds no page by
  // that name and resets the user's tab to the first one.
  check('activeName is left pointing at the user’s tab', L.activeName, 'native_1');
}

{
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('the tab that was active is put back', L.calls, ['switchPage:1']);
}

{
  const L = makeLayout();
  L.isMinimized.setValue(true);
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('a minimized bar stays minimized', L.calls, ['switchPage:1', 'minimize:true']);
}

{
  // Un-minimizing goes around switchPage: setMinimizedState calls
  // onActiveStateChange on the active page itself.
  const L = makeLayout();
  L.isMinimized.setValue(true);
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  const err = await failure(() => call('widgetbar_activate'));
  check('activating from a minimized bar does not throw', err, '');
  check('un-minimizing activated our page', page.active, true);
}

section('transitions');

{
  // Activating twice must not overwrite the remembered tab with our own.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  check('activate → activate → deactivate returns to the user’s tab', L.activeIndex, 1);
}

{
  // TradingView minimizes the bar when the resizer is dragged below 50px,
  // which makes isActive() false while our page is still the active one. The
  // old code took "not active" at face value on the next click on our tab and
  // lost the user's tab for good.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.setMinimizedState(true);
  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  check('after minimizing and clicking again we return to the user’s tab', L.activeIndex, 1);
}

{
  // The case a lenient fake used to hide: once our page is the active one,
  // ANY next click on a native tab makes switchPage call
  // prevPage.onActiveStateChange(false) on us. Without a tab the host throws
  // on its own assertion, the switch never completes, and the user's widget
  // bar is wedged until they reload.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  const err = await failure(() => L.switchPage(0));
  check('a native tab click after ours does not throw', err, '');
  check('the switch completes', L.activeIndex, 0);
  check('our page was deactivated', page.active, false);
  check('the native page was activated', L.pages[0].active, true);
}

{
  // The user moved to a native tab themselves while ours was open, so
  // deactivating must not move them anywhere.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.switchPage(0);
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('deactivating leaves the user’s chosen tab alone', L.activeIndex, 0);
  check('deactivating is a no-op when we are not active', L.calls, []);
}

{
  // Deactivating twice: the second call must move nothing.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('deactivate → deactivate calls nothing', L.calls, []);
  check('the index did not move', L.activeIndex, 1);
}

{
  // Our page was dropped from pages while it was active at position 0 — the
  // one case in which the host really drives activeIndex to -1. activate has
  // to refuse, and state must not confuse "we are not there" (-1) with "there
  // is no active page" (also -1) and declare itself active.
  const L = makeLayout(0);
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.removePage(page);
  const err = await failure(() => call('widgetbar_activate'));
  check('activating with no page in pages refuses', /not mounted/i.test(err), true);
  check('state does not confuse one -1 with the other', await call('widgetbar_state'), { active: false, minimized: false });
}

section('state');

{
  const L = makeLayout();
  const { call, adopt, posted } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  await settle();
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('activation emits an event', [evt.type, evt.payload], ['widgetbar-active', { active: true }]);
  check('the state reads back', await call('widgetbar_state'), {
    active: true,
    minimized: false,
  });
}

{
  const L = makeLayout();
  const { call, adopt, posted } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  await settle();
  posted.length = 0;
  L.switchPage(0);
  await settle();
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('somebody else’s tab turns ours off', [evt.type, evt.payload], ['widgetbar-active', { active: false }]);
}

{
  // De-duping: a repeated notification of the same value must not send a
  // second event.
  const L = makeLayout();
  const { call, adopt, posted } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  // The activation's own event is stamped asynchronously, so it has to have
  // landed before the log is cleared or it would be counted below.
  await settle();
  posted.length = 0;
  L.switchPage(0);
  L.switchPage(2);
  await settle();
  check('a repeat of the same active=false sends no second event', posted.filter((m) => m.source === 'tva-evt').length, 1);
}

{
  // The real layout.isMinimized is born with no value and stays undefined
  // until the bar first measures its own width. widgetbar_state and the
  // prevMinimized capture both have to read undefined as false rather than
  // carry it further.
  const L = makeLayout();
  L.isMinimized = watched();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);

  check('minimized === undefined reads as false', (await call('widgetbar_state')).minimized, false);

  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  check('prevMinimized from undefined does not try to minimize the bar again', L.calls.includes('minimize:true'), false);
}

report();
