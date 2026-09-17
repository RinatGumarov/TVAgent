/**
 * Loads the real extension modules the way Chrome gets them: bundled. The
 * bundle is evaluated with the globals the test hands in, and each call
 * returns its own instance, so a module holding state does not leak from one
 * test into the next.
 */
import { build, buildSync } from 'esbuild';
import path from 'node:path';

const SRC = new URL('../../src/', import.meta.url).pathname;

/** Bundling is the slow part, and the output only depends on what went in. */
const bundles = new Map();

/**
 * Stands in for a module the test replaces. Each export forwards to the
 * double on `window` at call time, through a Proxy so that a plain call, a
 * `new`, and a property read all reach it.
 */
function doubleSource(globalName, names) {
  const reach = (n) => `window[${JSON.stringify(globalName)}][${JSON.stringify(n)}]`;
  return names
    .map(
      (n) => `export const ${n} = new Proxy(function () {}, {
  get: (_t, p) => ${reach(n)}[p],
  apply: (_t, _this, a) => ${reach(n)}(...a),
  construct: (_t, a) => new (${reach(n)})(...a),
});`,
    )
    .join('\n');
}

/** Redirects the named modules to their doubles before esbuild reads them. */
function doublePlugin(doubles) {
  const byPath = new Map(
    Object.entries(doubles).map(([rel, spec]) => [path.resolve(SRC, rel), spec]),
  );
  return {
    name: 'tva-doubles',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer) return null;
        const abs = path.resolve(args.resolveDir, args.path);
        return byPath.has(abs) ? { path: abs, namespace: 'tva-double' } : null;
      });
      build.onLoad({ filter: /.*/, namespace: 'tva-double' }, (args) => {
        const { globalName, names } = byPath.get(args.path);
        return { contents: doubleSource(globalName, names), loader: 'js' };
      });
    },
  };
}

const options = (rel) => ({
  entryPoints: [SRC + rel],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__tvaModule',
  platform: 'browser',
  target: 'chrome111',
  logLevel: 'silent',
});

function bundle(rel) {
  if (!bundles.has(rel)) bundles.set(rel, buildSync(options(rel)).outputFiles[0].text);
  return bundles.get(rel);
}

/** Doubles need a plugin, and esbuild takes plugins only asynchronously. */
async function bundleWith(rel, doubles) {
  const key = rel + '|' + JSON.stringify(doubles);
  if (!bundles.has(key)) {
    const built = await build({ ...options(rel), plugins: [doublePlugin(doubles)] });
    bundles.set(key, built.outputFiles[0].text);
  }
  return bundles.get(key);
}

function evaluateBundle(code, scope) {
  const full = { globalThis: scope.window ?? scope.globalThis ?? globalThis, ...scope };
  const names = Object.keys(full);
  return new Function(...names, `${code}\nreturn __tvaModule;`)(...names.map((n) => full[n]));
}

/**
 * The module's exports, evaluated with `scope`'s keys as its globals, fresh
 * each call so that module state does not leak between tests.
 */
export function loadModule(rel, scope = {}) {
  return evaluateBundle(bundle(rel), scope);
}

/**
 * The same, with some of the module's dependencies replaced. `doubles` maps a
 * module path to the `window` property standing in for it, which the test has
 * already put there.
 */
export async function loadModuleWith(rel, scope, doubles) {
  const spec = Object.fromEntries(
    Object.entries(doubles).map(([mod, globalName]) => [
      mod,
      { globalName, names: Object.keys(scope.window[globalName]) },
    ]),
  );
  return evaluateBundle(await bundleWith(rel, spec), scope);
}

/**
 * A window that behaves enough like the page's: message delivery, timers and
 * crypto.
 */
export function makeWindow(extra = {}) {
  const listeners = [];
  const win = {
    location: { origin: 'https://www.tradingview.com' },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
      (win.listeners[type] = win.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = win.listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
      if (type === 'message') {
        const j = listeners.indexOf(fn);
        if (j !== -1) listeners.splice(j, 1);
      }
    },
    listeners: {},
    messageListeners: listeners,
    /** Delivers to this window only; makeWorlds() overrides it for two. */
    postMessage(data) {
      win.deliver(data, win.location.origin, win);
    },
    deliver(data, origin = win.location.origin, source = win) {
      listeners.slice().forEach((fn) => setTimeout(() => fn({ data, origin, source }), 0));
    },
    /**
     * Returns what each handler returned, promises included, so a test can
     * await them.
     */
    fire(type, evt) {
      return (win.listeners[type] || []).slice().map((fn) => fn(evt || {}));
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    ...extra,
  };
  return win;
}

/**
 * The page's two JavaScript worlds. They share one window for messaging,
 * which is the property the bridge's authentication exists to survive.
 * `page` is a third listener standing in for TradingView's own scripts.
 */
export function makeWorlds() {
  const worlds = [];
  const deliver = (data) => {
    for (const w of worlds) {
      w.messageListeners
        .slice()
        .forEach((fn) => setTimeout(() => fn({ data, origin: w.location.origin, source: w }), 0));
    }
  };
  const spawn = (extra) => {
    const win = makeWindow(extra);
    win.postMessage = (data) => deliver(data);
    worlds.push(win);
    return win;
  };
  return { spawn, deliver };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Lets every queued message task run. */
export const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await tick(0);
};
