/** Runs the real panel-mount.js under the fake DOM and a fake bridge. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/dom.mjs';
import { makeWindow, readSource } from './helpers/load.mjs';

const src = readSource('content/panel-mount.js');

function makeChrome(store = {}) {
  return {
    storage: {
      local: {
        get: async (key) =>
          typeof key === 'string' ? (key in store ? { [key]: store[key] } : {}) : { ...store },
        set: async (obj) => {
          Object.assign(store, obj);
        },
      },
    },
  };
}

/** The fake bridge.call('widgetbar_mount') puts a new page into the document. */
function makeMountedPage(doc) {
  const page = doc.createElement('div');
  page.id = 'tva-widgetbar-page';
  doc.documentElement.appendChild(page);
  return page;
}

function load({ window: win, document: doc, chrome: chr, bridge }) {
  win.TVAgentBridge = bridge;
  new Function('window', 'document', 'chrome', src)(win, doc, chr);
  return win.TVAgentMount;
}

describe('the native path', async () => {
  {
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    let mountCalls = 0;
    const bridge = {
      on() {},
      async call(method) {
        if (method === 'widgetbar_mount') {
          mountCalls++;
          const page = makeMountedPage(doc);
          return { ok: true, pageId: page.id };
        }
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    const { root, mode } = await Mount.mount();

    const got1 = mode;
    const want1 = 'native';
    it('native: mode', () => {
      assert.deepStrictEqual(got1, want1);
    });
    const got2 = mountCalls;
    const want2 = 1;
    it('native: widgetbar_mount was called once', () => {
      assert.deepStrictEqual(got2, want2);
    });
    const got3 = root.parent && root.parent.id;
    const want3 = 'tva-widgetbar-page';
    it('native: root is inside the widget bar page', () => {
      assert.deepStrictEqual(got3, want3);
    });
    const got4 = [
      root.classList.contains('tva-native'),
      root.classList.contains('tva-overlay'),
      root.classList.contains('tva-hidden'),
    ];
    const want4 = [true, false, false];
    it('native: classes are tva-native only, no overlay/hidden', () => {
      assert.deepStrictEqual(got4, want4);
    });
    const got5 = root.children.some((c) => c.className === 'tva-resizer');
    const want5 = false;
    it('native: no resizer was added', () => {
      assert.deepStrictEqual(got5, want5);
    });
  }
});

describe('the overlay path', async () => {
  {
    // An anonymous session: there is no window.widgetbar and the driver throws.
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    const infoLogs = [];
    const originalInfo = console.info;
    console.info = (...args) => infoLogs.push(args.join(' '));

    const bridge = {
      on() {},
      async call(method) {
        if (method === 'widgetbar_mount') {
          throw new Error('TradingView widget bar is not on this page (anonymous session?).');
        }
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    const { root, mode } = await Mount.mount();
    console.info = originalInfo;

    const got6 = mode;
    const want6 = 'overlay';
    it('overlay: mode', () => {
      assert.deepStrictEqual(got6, want6);
    });
    const got7 = root.parent === doc.documentElement;
    const want7 = true;
    it('overlay: root hangs off documentElement', () => {
      assert.deepStrictEqual(got7, want7);
    });
    const got8 = [
      root.classList.contains('tva-overlay'),
      root.classList.contains('tva-hidden'),
      root.classList.contains('tva-native'),
    ];
    const want8 = [true, true, false];
    it('overlay: classes are tva-overlay and tva-hidden, no native', () => {
      assert.deepStrictEqual(got8, want8);
    });
    const got9 = root.children.some((c) => c.className === 'tva-resizer');
    const want9 = true;
    it('overlay: a resizer was added', () => {
      assert.deepStrictEqual(got9, want9);
    });
    const got10 = infoLogs.some((s) => /widget bar unavailable/.test(s));
    const want10 = true;
    it('overlay: the reason was noted in the console', () => {
      assert.deepStrictEqual(got10, want10);
    });
  }
});

describe('toggle', async () => {
  {
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    const state = { active: false };
    const bridge = {
      calls: [],
      on() {},
      async call(method) {
        bridge.calls.push(method);
        if (method === 'widgetbar_mount') return { ok: true, pageId: makeMountedPage(doc).id };
        if (method === 'widgetbar_state') return { active: state.active };
        if (method === 'widgetbar_activate') {
          state.active = true;
          return { ok: true };
        }
        if (method === 'widgetbar_deactivate') {
          state.active = false;
          return { ok: true };
        }
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    await Mount.mount();

    bridge.calls.length = 0;
    await Mount.toggle();
    const got11 = [...bridge.calls];
    const want11 = ['widgetbar_state', 'widgetbar_activate'];
    it('native toggle asks for state, then activates', () => {
      assert.deepStrictEqual(got11, want11);
    });

    bridge.calls.length = 0;
    await Mount.toggle();
    const got12 = bridge.calls;
    const want12 = ['widgetbar_state', 'widgetbar_deactivate'];
    it('native toggle again asks for state, then deactivates', () => {
      assert.deepStrictEqual(got12, want12);
    });
  }

  {
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    const bridge = {
      calls: [],
      on() {},
      async call(method) {
        bridge.calls.push(method);
        if (method === 'widgetbar_mount') throw new Error('no widget bar');
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    const { root } = await Mount.mount();

    bridge.calls.length = 0;
    const got13 = root.classList.contains('tva-hidden');
    const want13 = true;
    it('the overlay starts hidden', () => {
      assert.deepStrictEqual(got13, want13);
    });
    await Mount.toggle();
    const got14 = [root.classList.contains('tva-hidden'), bridge.calls];
    const want14 = [false, []];
    it('overlay toggle shows the panel, the bridge is untouched', () => {
      assert.deepStrictEqual(got14, want14);
    });
    await Mount.toggle();
    const got15 = [root.classList.contains('tva-hidden'), bridge.calls];
    const want15 = [true, []];
    it('overlay toggle hides it again, still untouched', () => {
      assert.deepStrictEqual(got15, want15);
    });
  }
});

describe('onActive', async () => {
  {
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    let handler = null;
    let onCalls = 0;
    const bridge = {
      on(type, fn) {
        onCalls++;
        if (type === 'widgetbar-active') handler = fn;
      },
      async call(method) {
        if (method === 'widgetbar_mount') return { ok: true, pageId: makeMountedPage(doc).id };
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    await Mount.mount();

    const seen = [];
    Mount.onActive((active) => seen.push(active));
    handler({ active: true });
    handler({ active: false });
    const got16 = seen;
    const want16 = [true, false];
    it('onActive gets what the bridge sends', () => {
      assert.deepStrictEqual(got16, want16);
    });
    const got17 = onCalls;
    const want17 = 1;
    it('bridge.on was called once', () => {
      assert.deepStrictEqual(got17, want17);
    });
  }
});

describe('bfcache restore', async () => {
  {
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    let mountCalls = 0;
    let onCalls = 0;
    const bridge = {
      on() {
        onCalls++;
      },
      async call(method) {
        if (method === 'widgetbar_mount') {
          mountCalls++;
          return { ok: true, pageId: makeMountedPage(doc).id };
        }
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    const { root } = await Mount.mount();
    const firstHost = root.parent;
    const got18 = mountCalls;
    const want18 = 1;
    it('the first mount created a page', () => {
      assert.deepStrictEqual(got18, want18);
    });

    // The conversation inside the panel is what has to survive the restore.
    const chatMsg = doc.createElement('div');
    chatMsg.className = 'tva-msg';
    root.appendChild(chatMsg);

    // What the driver's pagehide teardown does: the page element goes, but not
    // what the content script put inside it.
    firstHost.remove();
    const got19 = doc.getElementById('tva-widgetbar-page');
    const want19 = null;
    it('the old page is detached from the document', () => {
      assert.deepStrictEqual(got19, want19);
    });
    const got20 = [firstHost.children.includes(root), root.children.includes(chatMsg)];
    const want20 = [true, true];
    it('root, message and all, went with the old node rather than being rebuilt', () => {
      assert.deepStrictEqual(got20, want20);
    });

    await Promise.all(win.fire('pageshow', { persisted: true }));

    const got21 = mountCalls;
    const want21 = 2;
    it('pageshow with persisted=true calls widgetbar_mount again', () => {
      assert.deepStrictEqual(got21, want21);
    });
    const newHost = doc.getElementById('tva-widgetbar-page');
    const got22 = newHost !== firstHost;
    const want22 = true;
    it('it is a new page, not the old one', () => {
      assert.deepStrictEqual(got22, want22);
    });
    const got23 = root.parent === newHost;
    const want23 = true;
    it('the very same root moved into it', () => {
      assert.deepStrictEqual(got23, want23);
    });
    const got24 = firstHost.children.includes(root);
    const want24 = false;
    it('and was taken off the old page', () => {
      assert.deepStrictEqual(got24, want24);
    });
    const got25 = root.children.includes(chatMsg);
    const want25 = true;
    it('the message inside root survived the move', () => {
      assert.deepStrictEqual(got25, want25);
    });
    const got26 = onCalls;
    const want26 = 1;
    it('the widgetbar-active listener was not doubled by the remount', () => {
      assert.deepStrictEqual(got26, want26);
    });
  }

  {
    // persisted=false is an ordinary navigation, not bfcache: nothing to remount.
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    let mountCalls = 0;
    const bridge = {
      on() {},
      async call(method) {
        if (method === 'widgetbar_mount') {
          mountCalls++;
          return { ok: true, pageId: makeMountedPage(doc).id };
        }
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    await Mount.mount();
    const got27 = mountCalls;
    const want27 = 1;
    it('after an ordinary mount', () => {
      assert.deepStrictEqual(got27, want27);
    });

    await Promise.all(win.fire('pageshow', { persisted: false }));
    const got28 = mountCalls;
    const want28 = 1;
    it('pageshow with persisted=false remounts nothing', () => {
      assert.deepStrictEqual(got28, want28);
    });
  }
});

describe('bfcache restore: the remount fails', async () => {
  {
    // The user logged out in another tab, so there is no widget bar by the time
    // the restore tries; the panel has to fall back to the overlay.
    const doc = makeDocument();
    const win = makeWindow();
    const chr = makeChrome();
    let shouldFail = false;
    let activeHandler = null;
    const bridge = {
      on(type, fn) {
        if (type === 'widgetbar-active') activeHandler = fn;
      },
      async call(method) {
        if (method === 'widgetbar_mount') {
          if (shouldFail)
            throw new Error('TradingView widget bar is not on this page (anonymous session?).');
          return { ok: true, pageId: makeMountedPage(doc).id };
        }
        throw new Error('unexpected call ' + method);
      },
    };
    const Mount = load({ window: win, document: doc, chrome: chr, bridge });
    const { root } = await Mount.mount();
    const firstHost = root.parent;
    firstHost.remove();
    shouldFail = true;

    await Promise.all(win.fire('pageshow', { persisted: true }));

    const got29 = Mount.mode();
    const want29 = 'overlay';
    it('a failed remount falls back to the overlay', () => {
      assert.deepStrictEqual(got29, want29);
    });
    const got30 = root.parent === doc.documentElement;
    const want30 = true;
    it('root moved onto documentElement', () => {
      assert.deepStrictEqual(got30, want30);
    });
    const got31 = [
      root.classList.contains('tva-overlay'),
      root.classList.contains('tva-hidden'),
      root.classList.contains('tva-native'),
    ];
    const want31 = [true, true, false];
    it('the classes are overlay/hidden now, native is gone', () => {
      assert.deepStrictEqual(got31, want31);
    });
    const got32 = root.children.some((c) => c.className === 'tva-resizer');
    const want32 = true;
    it('a resizer was wired up on the fallback', () => {
      assert.deepStrictEqual(got32, want32);
    });

    // The driver's layout subscriptions outlive the mount, so a stale
    // widgetbar-active can still arrive after the fallback; it must not reach
    // onActive.
    const seen = [];
    Mount.onActive((active) => seen.push(active));
    const got33 = typeof activeHandler;
    const want33 = 'function';
    it('the widgetbar-active listener is still attached', () => {
      assert.deepStrictEqual(got33, want33);
    });
    activeHandler({ active: false });
    const got34 = seen;
    const want34 = [];
    it('a stale event after the fallback does not reach onActive', () => {
      assert.deepStrictEqual(got34, want34);
    });
  }
});
