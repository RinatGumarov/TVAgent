/**
 * Runs the real driver.js against a fake window.widgetbar. The fake holds the
 * host's contract: a page without a tab throws on activation, and createPage
 * hands back a page with neither tab nor name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSource, settle } from './helpers/load.mjs';

const src = readSource('injected/driver.js');

/**
 * An observable with the same interface as TradingView's. With no argument
 * it behaves like a freshly constructed one: value() is undefined until the
 * bar first measures itself.
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
    count: () => subs.length,
  };
}

// ------------------------------------------------------------------ DOM

/**
 * The MutationObservers alive in this run. A real one batches into a
 * microtask; this one calls back synchronously, which is stricter.
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
 * The selectors the driver is allowed to ask for. Anything else is an error
 * rather than a quiet guess.
 */
const BUTTON_SELECTORS = [
  'button[data-name][aria-pressed="false"]:not(:disabled)',
  'button[data-name]:not(:disabled)',
];
const DOCUMENT_SELECTORS = ['.widgetbar-pagescontent', '[data-name="right-toolbar"]'];

function unknownSelector(sel, known) {
  return new Error(
    `the fake does not know the selector ${JSON.stringify(sel)} (it knows ${known.join(', ')}) — ` +
      'update it deliberately, alongside the driver',
  );
}

/**
 * A minimal node. querySelector understands exactly the selectors the driver
 * uses.
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
    setAttribute: (k, v) => {
      e.attrs[k] = String(v);
    },
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
 * first (fullscreen only, no aria-pressed), then the tabs, then the filler
 * that ends the top group.
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
 * A complete document whose querySelector answers null until reveal() is
 * called, which is what the browser sees before TradingView has built the
 * widget bar.
 */
function makeDelayedFullDocument(toolbar = makeToolbar()) {
  const full = makeFullDocument(toolbar);
  let ready = false;
  return {
    ...full,
    querySelector: (sel) => (ready ? full.querySelector(sel) : null),
    reveal: () => {
      ready = true;
    },
  };
}

/**
 * A setTimeout that does not spend real time, for the test that exhausts the
 * wait budget.
 */
function instantTimer(fn) {
  setTimeout(fn, 0);
}

// ------------------------------------------------------------------ layout

/**
 * A page in the state the host hands it back in: onActiveStateChange throws
 * when the page has no tab, exactly as the host does.
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
      if (!page.tab) throw new Error('Value is undefined');
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
 * ones, and onTabClick only records that it was called, because the driver
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
    // Takes either an index or a page object, and does nothing for a detached
    // page. activePageIndex is updated before onActiveStateChange, as in the
    // host.
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
      // The host only compensates for removing the active page:
      // switchPage(i-1).
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
    crypto: globalThis.crypto,
    TradingViewApi: {},
    widgetbar: layout ? { layout } : undefined,
    // The driver reads this flag to tell "not yet" from "never".
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
  const localStorage = { getItem: (k) => (k === 'tv-agent-debug' ? '1' : null) };

  for (const rel of ['shared/wire.js', 'shared/wait.js']) {
    new Function('globalThis', 'window', readSource(rel))(win, win);
  }

  // setTimeout is a sandbox parameter because the driver calls it as a bare
  // identifier; only the exhausted-budget test substitutes one.
  new Function('window', 'document', 'localStorage', 'performance', 'setTimeout', src)(
    win,
    doc,
    localStorage,
    { now: () => 0 },
    setTimeoutImpl || setTimeout,
  );
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

describe('mounting', async () => {
  {
    const { call } = load({ layout: null });
    const err = await failure(() => call('widgetbar_mount'));
    const got1 = /widget bar/i.test(err);
    const want1 = true;
    it('with no window.widgetbar, mounting refuses', () => {
      assert.deepStrictEqual(got1, want1);
    });
  }

  {
    // Both the bar and the toolbar are present, so this fails inside wbMount
    // rather than in the wait for the bar.
    const L = makeLayout();
    const doc = makeDocument({ '[data-name="right-toolbar"]': makeToolbar() });
    const { call } = load({ layout: L, document: doc });
    const err = await failure(() => call('widgetbar_mount'));
    const got2 = /page container/i.test(err);
    const want2 = true;
    it('with no page container, mounting refuses', () => {
      assert.deepStrictEqual(got2, want2);
    });
    const got3 = L.calls;
    const want3 = [];
    it('no page was created', () => {
      assert.deepStrictEqual(got3, want3);
    });
  }

  {
    // The hide_right_toolbar_tabs featureset renders no toolbar at all, and
    // waitForWidgetBar cannot tell a permanent absence from a slow load.
    const doc = makeFullDocument();
    doc.querySelector = (sel) => (sel === '.widgetbar-pagescontent' ? doc.content : null);
    const L = makeLayout(3, doc);
    const { call } = load({
      layout: L,
      document: doc,
      isAuthenticated: true,
      setTimeoutImpl: instantTimer,
    });
    const err = await failure(() => call('widgetbar_mount'));
    const got4 = /timed out/i.test(err);
    const want4 = true;
    it('with no toolbar, mounting refuses on the timeout', () => {
      assert.deepStrictEqual(got4, want4);
    });
    const got5 = L.calls;
    const want5 = [];
    it('no page was created at all', () => {
      assert.deepStrictEqual(got5, want5);
    });
    const got6 = doc.content.children.length;
    const want6 = 0;
    it('no page element appeared in the DOM', () => {
      assert.deepStrictEqual(got6, want6);
    });
  }

  {
    const doc = makeFullDocument();
    const L = makeLayout(3, doc);
    const { call } = load({ layout: L, document: doc });
    const res = await call('widgetbar_mount');
    const got7 = res;
    const want7 = { ok: true, pageId: 'tva-widgetbar-page' };
    it('mounting hands back the page id', () => {
      assert.deepStrictEqual(got7, want7);
    });
    const got8 = L.pages.length;
    const want8 = 4;
    it('the page was added', () => {
      assert.deepStrictEqual(got8, want8);
    });

    const page = L.pages[3];
    const got9 = Boolean(page.tab);
    const want9 = true;
    it('the page has a tab', () => {
      assert.deepStrictEqual(got9, want9);
    });
    const got10 = page.name;
    const want10 = 'tva_agent';
    it('the page has a name', () => {
      assert.deepStrictEqual(got10, want10);
    });

    const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
    const filler = doc.toolbar.children.find((c) => c.tagName !== 'BUTTON');
    const got11 = doc.toolbar.children.indexOf(btn) + 1;
    const want11 = doc.toolbar.children.indexOf(filler);
    it('the button went into the top group, before the filler', () => {
      assert.deepStrictEqual(got11, want11);
    });
    const got12 = btn.attrs.tabindex;
    const want12 = '-1';
    it('the button does not steal the toolbar tab stop', () => {
      assert.deepStrictEqual(got12, want12);
    });
    // `base` is the first button[data-name] in the DOM and is active by
    // default: a clone of it would carry the active-state hash and stay lit.
    const got13 = btn.classes.has('hash-active');
    const want13 = false;
    it('the clone did not carry the active tab hash', () => {
      assert.deepStrictEqual(got13, want13);
    });
  }

  {
    // Mounting again over a live mount is a no-op.
    const doc = makeFullDocument();
    const L = makeLayout(3, doc);
    const { call } = load({ layout: L, document: doc });
    await call('widgetbar_mount');
    await call('widgetbar_mount');
    const got14 = L.pages.length;
    const want14 = 4;
    it('a second mount creates no second page', () => {
      assert.deepStrictEqual(got14, want14);
    });
    const got15 = doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length;
    const want15 = 1;
    it('a second mount creates no second button', () => {
      assert.deepStrictEqual(got15, want15);
    });
  }

  {
    // The element was dropped from the DOM. Mount has to clear away what the
    // previous one left rather than grow a second page and button.
    const doc = makeFullDocument();
    const L = makeLayout(3, doc);
    const { call, observers } = load({ layout: L, document: doc });
    await call('widgetbar_mount');
    const firstButton = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
    L.pages[3].el.remove(); // the element was detached
    await call('widgetbar_mount');
    const got16 = L.pages.length;
    const want16 = 4;
    it('remounting leaves no second page', () => {
      assert.deepStrictEqual(got16, want16);
    });
    const got17 = doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length;
    const want17 = 1;
    it('remounting leaves no second button', () => {
      assert.deepStrictEqual(got17, want17);
    });
    const got18 = doc.toolbar.contains(firstButton);
    const want18 = false;
    it('the old button was taken out of the toolbar', () => {
      assert.deepStrictEqual(got18, want18);
    });
    // The old observer holds the old button and would put it back.
    const got19 = observers.map((o) => o.connected);
    const want19 = [false, true];
    it('the old observer is disconnected, the new one connected', () => {
      assert.deepStrictEqual(got19, want19);
    });
  }

  {
    // React dropped our button. The observer has to put it back and then stop.
    const doc = makeFullDocument();
    const L = makeLayout(3, doc);
    const { call, observers } = load({ layout: L, document: doc });
    await call('widgetbar_mount');
    const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
    observers[0].calls = 0;
    btn.remove();
    const filler = doc.toolbar.children.find((c) => c.tagName !== 'BUTTON');
    const got20 = doc.toolbar.contains(btn);
    const want20 = true;
    it('the button was put back in the toolbar', () => {
      assert.deepStrictEqual(got20, want20);
    });
    const got21 = doc.toolbar.children.indexOf(btn) + 1;
    const want21 = doc.toolbar.children.indexOf(filler);
    it('and in its old place, at the end of the top group', () => {
      assert.deepStrictEqual(got21, want21);
    });
    // One callback for the removal, one for the re-insertion, and that is all.
    const got22 = observers[0].calls;
    const want22 = 2;
    it('putting it back does not loop', () => {
      assert.deepStrictEqual(got22, want22);
    });
  }

  {
    // Unload uses pagehide, which works with the bfcache, and is armed only
    // after a mount.
    const doc = makeFullDocument();
    const L = makeLayout(3, doc);
    const { call, fire, listenerCount } = load({ layout: L, document: doc });
    const got23 = listenerCount('pagehide');
    const want23 = 0;
    it('nothing is bound to unload before a mount', () => {
      assert.deepStrictEqual(got23, want23);
    });
    const got24 = listenerCount('beforeunload');
    const want24 = 0;
    it('beforeunload is not used at all', () => {
      assert.deepStrictEqual(got24, want24);
    });
    await call('widgetbar_mount');
    const got25 = await failure(() => call('widgetbar_activate'));
    const want25 = '';
    it('mount and activate both go through', () => {
      assert.deepStrictEqual(got25, want25);
    });
    const got26 = listenerCount('pagehide');
    const want26 = 1;
    it('the unload listener appeared with the mount', () => {
      assert.deepStrictEqual(got26, want26);
    });
    fire('pagehide');
    const got27 = L.pages.length;
    const want27 = 3;
    it('on unload the page leaves layout.pages', () => {
      assert.deepStrictEqual(got27, want27);
    });
    const got28 = L.activeIndex;
    const want28 = 1;
    it('and the user is put back on their own tab', () => {
      assert.deepStrictEqual(got28, want28);
    });
  }

  {
    // The user logs in mid-session: TradingView destroys the whole layout and
    // installs a fresh object. Our subscriptions have to move with it.
    const doc = makeFullDocument();
    const L1 = makeLayout(3, doc);
    const { call, posted, win } = load({ layout: L1, document: doc });
    await call('widgetbar_mount');
    await call('widgetbar_activate');
    const got29 = [L1.activePageIndex.count(), L1.isMinimized.count()];
    const want29 = [1, 1];
    it('the subscriptions are on the first layout', () => {
      assert.deepStrictEqual(got29, want29);
    });

    const L2 = makeLayout(3, doc);
    // destroy() takes the whole page container; document.contains(wb.el) turns
    // false.
    doc.content.children.slice().forEach((c) => c.remove());
    win.widgetbar.layout = L2;

    await call('widgetbar_mount');
    const got30 = L2.pages.length;
    const want30 = 4;
    it('the page was rebuilt in the new layout', () => {
      assert.deepStrictEqual(got30, want30);
    });
    const got31 = [L1.activePageIndex.count(), L1.isMinimized.count()];
    const want31 = [0, 0];
    it('the old layout was unsubscribed from', () => {
      assert.deepStrictEqual(got31, want31);
    });
    const got32 = [L2.activePageIndex.count(), L2.isMinimized.count()];
    const want32 = [1, 1];
    it('and the new one subscribed to', () => {
      assert.deepStrictEqual(got32, want32);
    });

    posted.length = 0;
    L2.switchPage(3);
    // Every event carries a stamp, and making one is asynchronous — so an emit
    // lands a microtask after the call that caused it.
    await settle();
    const evt = posted.filter((m) => m.source === 'tva-evt').pop();
    const got33 = [evt && evt.type, evt && evt.payload];
    const want33 = ['widgetbar-active', { active: true }];
    it('the new layout drives our state again', () => {
      assert.deepStrictEqual(got33, want33);
    });
  }
});

describe('the race for the bar to appear', async () => {
  {
    // On a live page window.widgetbar appears a second or so after the driver
    // has taken its first widgetbar_mount. Mounting has to wait it out.
    const doc = makeDelayedFullDocument();
    const L = makeLayout(3, doc);
    const { call, win } = load({ layout: null, document: doc, isAuthenticated: true });
    setTimeout(() => {
      doc.reveal();
      win.widgetbar = { layout: L };
    }, 350);
    const res = await call('widgetbar_mount');
    const got34 = res;
    const want34 = {
      ok: true,
      pageId: 'tva-widgetbar-page',
    };
    it('race: mounting waits for the bar rather than refusing', () => {
      assert.deepStrictEqual(got34, want34);
    });
    const got35 = L.pages.length;
    const want35 = 4;
    it('race: the page was created', () => {
      assert.deepStrictEqual(got35, want35);
    });
    const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
    const got36 = Boolean(btn);
    const want36 = true;
    it('race: the button went into the toolbar', () => {
      assert.deepStrictEqual(got36, want36);
    });
    const got37 = doc.content.children.includes(L.pages[3].el);
    const want37 = true;
    it('race: the page element is in the container', () => {
      assert.deepStrictEqual(got37, want37);
    });
  }

  {
    // While the first widgetbar_mount is parked in the poll, a second one must
    // not run the body again.
    const doc = makeDelayedFullDocument();
    const L = makeLayout(3, doc);
    const { call, win } = load({ layout: null, document: doc, isAuthenticated: true });
    setTimeout(() => {
      doc.reveal();
      win.widgetbar = { layout: L };
    }, 350);
    const [res1, res2] = await Promise.all([call('widgetbar_mount'), call('widgetbar_mount')]);
    const got38 = [res1, res2];
    const want38 = [
      { ok: true, pageId: 'tva-widgetbar-page' },
      { ok: true, pageId: 'tva-widgetbar-page' },
    ];
    it('concurrent mounts: both resolve to one result', () => {
      assert.deepStrictEqual(got38, want38);
    });
    const got39 = L.pages.length;
    const want39 = 4;
    it('concurrent mounts: only one page was created', () => {
      assert.deepStrictEqual(got39, want39);
    });
    const got40 = doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length;
    const want40 = 1;
    it('concurrent mounts: only one button was created', () => {
      assert.deepStrictEqual(got40, want40);
    });
  }

  {
    // An anonymous session: there will never be a bar, and that is known at
    // once from window.is_authenticated.
    const doc = makeDocument();
    const { call } = load({ layout: null, document: doc, isAuthenticated: false });
    const t0 = Date.now();
    const err = await failure(() => call('widgetbar_mount'));
    const elapsed = Date.now() - t0;
    const got41 = /anonymous/i.test(err);
    const want41 = true;
    it('not authenticated: refused as an anonymous session', () => {
      assert.deepStrictEqual(got41, want41);
    });
    const got42 = elapsed < 100;
    const want42 = true;
    it('not authenticated: refused at once, without polling', () => {
      assert.deepStrictEqual(got42, want42);
    });
  }

  {
    // Authenticated, but the bar never arrived within the budget. The message
    // has to say timeout, not blame an anonymous session.
    const doc = makeDocument();
    const { call } = load({
      layout: null,
      document: doc,
      isAuthenticated: true,
      setTimeoutImpl: instantTimer,
    });
    const err = await failure(() => call('widgetbar_mount'));
    const got43 = /timed out/i.test(err);
    const want43 = true;
    it('timeout: the message says timeout', () => {
      assert.deepStrictEqual(got43, want43);
    });
    const got44 = /anonymous/i.test(err);
    const want44 = false;
    it('timeout: the message does not blame an anonymous session', () => {
      assert.deepStrictEqual(got44, want44);
    });
  }
});

describe('activation', async () => {
  {
    const L = makeLayout();
    const { call, adopt } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    L.calls.length = 0;
    await call('widgetbar_activate');
    // The end state, not the call log: the real setMinimizedState says nothing
    // when the value has not changed.
    const got45 = [L.activeIndex, L.isMinimized.value()];
    const want45 = [3, false];
    it('we switch to our page and un-minimize', () => {
      assert.deepStrictEqual(got45, want45);
    });
    const got46 = L.calls.includes('onTabClick');
    const want46 = false;
    it('the host tab-click handler was never called', () => {
      assert.deepStrictEqual(got46, want46);
    });
    const got47 = page.active;
    const want47 = true;
    it('the host activated our page', () => {
      assert.deepStrictEqual(got47, want47);
    });
    // switchPage writes our name into layout.activeName, which the next
    // settings save would persist.
    const got48 = L.activeName;
    const want48 = 'native_1';
    it('activeName is left pointing at the user’s tab', () => {
      assert.deepStrictEqual(got48, want48);
    });
  }

  {
    const L = makeLayout();
    const { call, adopt } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    await call('widgetbar_activate');
    L.calls.length = 0;
    await call('widgetbar_deactivate');
    const got49 = L.calls;
    const want49 = ['switchPage:1'];
    it('the tab that was active is put back', () => {
      assert.deepStrictEqual(got49, want49);
    });
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
    const got50 = L.calls;
    const want50 = ['switchPage:1', 'minimize:true'];
    it('a minimized bar stays minimized', () => {
      assert.deepStrictEqual(got50, want50);
    });
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
    const got51 = err;
    const want51 = '';
    it('activating from a minimized bar does not throw', () => {
      assert.deepStrictEqual(got51, want51);
    });
    const got52 = page.active;
    const want52 = true;
    it('un-minimizing activated our page', () => {
      assert.deepStrictEqual(got52, want52);
    });
  }
});

describe('transitions', async () => {
  {
    // Activating twice must not overwrite the remembered tab with our own.
    const L = makeLayout();
    const { call, adopt } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    await call('widgetbar_activate');
    await call('widgetbar_activate');
    await call('widgetbar_deactivate');
    const got53 = L.activeIndex;
    const want53 = 1;
    it('activate → activate → deactivate returns to the user’s tab', () => {
      assert.deepStrictEqual(got53, want53);
    });
  }

  {
    // TradingView minimizes the bar when the resizer is dragged below 50px,
    // which makes isActive() false while our page is still the active one.
    const L = makeLayout();
    const { call, adopt } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    await call('widgetbar_activate');
    L.setMinimizedState(true);
    await call('widgetbar_activate');
    await call('widgetbar_deactivate');
    const got54 = L.activeIndex;
    const want54 = 1;
    it('after minimizing and clicking again we return to the user’s tab', () => {
      assert.deepStrictEqual(got54, want54);
    });
  }

  {
    // Once our page is the active one, the next click on a native tab makes
    // switchPage call onActiveStateChange(false) on us; without a tab the host
    // would throw.
    const L = makeLayout();
    const { call, adopt } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    await call('widgetbar_activate');
    const err = await failure(() => L.switchPage(0));
    const got55 = err;
    const want55 = '';
    it('a native tab click after ours does not throw', () => {
      assert.deepStrictEqual(got55, want55);
    });
    const got56 = L.activeIndex;
    const want56 = 0;
    it('the switch completes', () => {
      assert.deepStrictEqual(got56, want56);
    });
    const got57 = page.active;
    const want57 = false;
    it('our page was deactivated', () => {
      assert.deepStrictEqual(got57, want57);
    });
    const got58 = L.pages[0].active;
    const want58 = true;
    it('the native page was activated', () => {
      assert.deepStrictEqual(got58, want58);
    });
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
    const got59 = L.activeIndex;
    const want59 = 0;
    it('deactivating leaves the user’s chosen tab alone', () => {
      assert.deepStrictEqual(got59, want59);
    });
    const got60 = L.calls;
    const want60 = [];
    it('deactivating is a no-op when we are not active', () => {
      assert.deepStrictEqual(got60, want60);
    });
  }

  {
    // Our page was dropped from pages while active at position 0, the one case
    // in which the host drives activeIndex to -1.
    const L = makeLayout(0);
    const { call, adopt } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    await call('widgetbar_activate');
    L.removePage(page);
    const err = await failure(() => call('widgetbar_activate'));
    const got61 = /not mounted/i.test(err);
    const want61 = true;
    it('activating with no page in pages refuses', () => {
      assert.deepStrictEqual(got61, want61);
    });
    const got62 = await call('widgetbar_state');
    const want62 = {
      active: false,
      minimized: false,
    };
    it('state does not confuse one -1 with the other', () => {
      assert.deepStrictEqual(got62, want62);
    });
  }
});

describe('state', async () => {
  {
    const L = makeLayout();
    const { call, adopt, posted } = load({ layout: L });
    const page = L.createPage();
    adopt(page);
    await call('widgetbar_activate');
    await settle();
    const evt = posted.filter((m) => m.source === 'tva-evt').pop();
    const got63 = [evt.type, evt.payload];
    const want63 = ['widgetbar-active', { active: true }];
    it('activation emits an event', () => {
      assert.deepStrictEqual(got63, want63);
    });
    const got64 = await call('widgetbar_state');
    const want64 = {
      active: true,
      minimized: false,
    };
    it('the state reads back', () => {
      assert.deepStrictEqual(got64, want64);
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
    const got65 = [evt.type, evt.payload];
    const want65 = ['widgetbar-active', { active: false }];
    it('somebody else’s tab turns ours off', () => {
      assert.deepStrictEqual(got65, want65);
    });
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
    const got66 = posted.filter((m) => m.source === 'tva-evt').length;
    const want66 = 1;
    it('a repeat of the same active=false sends no second event', () => {
      assert.deepStrictEqual(got66, want66);
    });
  }
});
