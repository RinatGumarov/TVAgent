/** Runs the real panel-mount.js under the fake DOM and a fake bridge. */
import { check, section, report } from './helpers/check.mjs';
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

section('the native path');

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

  check('native: mode', mode, 'native');
  check('native: widgetbar_mount was called once', mountCalls, 1);
  check(
    'native: root is inside the widget bar page',
    root.parent && root.parent.id,
    'tva-widgetbar-page',
  );
  check(
    'native: classes are tva-native only, no overlay/hidden',
    [
      root.classList.contains('tva-native'),
      root.classList.contains('tva-overlay'),
      root.classList.contains('tva-hidden'),
    ],
    [true, false, false],
  );
  check(
    'native: no resizer was added',
    root.children.some((c) => c.className === 'tva-resizer'),
    false,
  );
}

section('the overlay path');

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

  check('overlay: mode', mode, 'overlay');
  check('overlay: root hangs off documentElement', root.parent === doc.documentElement, true);
  check(
    'overlay: classes are tva-overlay and tva-hidden, no native',
    [
      root.classList.contains('tva-overlay'),
      root.classList.contains('tva-hidden'),
      root.classList.contains('tva-native'),
    ],
    [true, true, false],
  );
  check(
    'overlay: a resizer was added',
    root.children.some((c) => c.className === 'tva-resizer'),
    true,
  );
  check(
    'overlay: the reason was noted in the console',
    infoLogs.some((s) => /widget bar unavailable/.test(s)),
    true,
  );
}

section('toggle');

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
  check('native toggle asks for state, then activates', bridge.calls, [
    'widgetbar_state',
    'widgetbar_activate',
  ]);

  bridge.calls.length = 0;
  await Mount.toggle();
  check('native toggle again asks for state, then deactivates', bridge.calls, [
    'widgetbar_state',
    'widgetbar_deactivate',
  ]);
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
  check('the overlay starts hidden', root.classList.contains('tva-hidden'), true);
  await Mount.toggle();
  check(
    'overlay toggle shows the panel, the bridge is untouched',
    [root.classList.contains('tva-hidden'), bridge.calls],
    [false, []],
  );
  await Mount.toggle();
  check(
    'overlay toggle hides it again, still untouched',
    [root.classList.contains('tva-hidden'), bridge.calls],
    [true, []],
  );
}

section('onActive');

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
  check('onActive gets what the bridge sends', seen, [true, false]);
  check('bridge.on was called once', onCalls, 1);
}

section('bfcache restore');

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
  check('the first mount created a page', mountCalls, 1);

  // The conversation inside the panel is what has to survive the restore.
  const chatMsg = doc.createElement('div');
  chatMsg.className = 'tva-msg';
  root.appendChild(chatMsg);

  // What the driver's pagehide teardown does: the page element goes, but not
  // what the content script put inside it.
  firstHost.remove();
  check(
    'the old page is detached from the document',
    doc.getElementById('tva-widgetbar-page'),
    null,
  );
  check(
    'root, message and all, went with the old node rather than being rebuilt',
    [firstHost.children.includes(root), root.children.includes(chatMsg)],
    [true, true],
  );

  await Promise.all(win.fire('pageshow', { persisted: true }));

  check('pageshow with persisted=true calls widgetbar_mount again', mountCalls, 2);
  const newHost = doc.getElementById('tva-widgetbar-page');
  check('it is a new page, not the old one', newHost !== firstHost, true);
  check('the very same root moved into it', root.parent === newHost, true);
  check('and was taken off the old page', firstHost.children.includes(root), false);
  check('the message inside root survived the move', root.children.includes(chatMsg), true);
  check('the widgetbar-active listener was not doubled by the remount', onCalls, 1);
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
  check('after an ordinary mount', mountCalls, 1);

  await Promise.all(win.fire('pageshow', { persisted: false }));
  check('pageshow with persisted=false remounts nothing', mountCalls, 1);
}

section('bfcache restore: the remount fails');

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

  check('a failed remount falls back to the overlay', Mount.mode(), 'overlay');
  check('root moved onto documentElement', root.parent === doc.documentElement, true);
  check(
    'the classes are overlay/hidden now, native is gone',
    [
      root.classList.contains('tva-overlay'),
      root.classList.contains('tva-hidden'),
      root.classList.contains('tva-native'),
    ],
    [true, true, false],
  );
  check(
    'a resizer was wired up on the fallback',
    root.children.some((c) => c.className === 'tva-resizer'),
    true,
  );

  // The driver's layout subscriptions outlive the mount, so a stale
  // widgetbar-active can still arrive after the fallback; it must not reach
  // onActive.
  const seen = [];
  Mount.onActive((active) => seen.push(active));
  check('the widgetbar-active listener is still attached', typeof activeHandler, 'function');
  activeHandler({ active: false });
  check('a stale event after the fallback does not reach onActive', seen, []);
}

report();
