/**
 * TVAgent tests — running the real extension sources under a fake window.
 *
 * None of these files are modules: they are content scripts and a service
 * worker, and they hang their exports off `window`/`globalThis`. So they are
 * read from disk and evaluated with the globals they expect handed in, which
 * is also what keeps the tests honest — they run the shipped file, not a copy
 * of it that has been made importable.
 */
import fs from 'node:fs';

export const EXT = new URL('../../extension/src/', import.meta.url).pathname;

export const readSource = (rel) => fs.readFileSync(EXT + rel, 'utf8');

/**
 * Evaluates one source file with `scope`'s keys as its globals.
 * `window` doubles as `globalThis` unless the caller says otherwise, because
 * the shared modules assign to `globalThis` and the content scripts to
 * `window`, and in a browser those are the same object.
 */
export function evaluate(rel, scope) {
  const full = { globalThis: scope.window, ...scope };
  const names = Object.keys(full);
  new Function(...names, readSource(rel))(...names.map((n) => full[n]));
  return scope.window;
}

/**
 * The shared modules, evaluated into one object that stands in for the
 * worker's `globalThis`. The worker reaches them through importScripts, which
 * does not exist under node — so the tests hand them in as parameters and stub
 * importScripts out, which runs the same file the worker runs.
 */
export function loadShared(...rels) {
  // wire.js reads crypto at load, so the stand-in globalThis has to carry the
  // real one before anything is evaluated into it.
  const scope = { crypto: globalThis.crypto };
  for (const rel of rels) new Function('globalThis', 'window', readSource(rel))(scope, scope);
  return scope;
}

/**
 * A window that behaves enough like the page's for the modules under test:
 * message delivery, timers and crypto.
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
     * Returns what each handler returned — including the promises of async
     * ones — so a test can await them instead of guessing at a sleep.
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
 * The page's two JavaScript worlds.
 *
 * They share one window for messaging — a postMessage from either is
 * delivered to the listeners of both, which is exactly the property the page
 * bridge's authentication exists to survive — but nothing else. `page` is a
 * third listener standing in for TradingView's own scripts.
 */
export function makeWorlds() {
  const worlds = [];
  const deliver = (data) => {
    for (const w of worlds) {
      w.messageListeners.slice().forEach((fn) =>
        setTimeout(() => fn({ data, origin: w.location.origin, source: w }), 0)
      );
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
