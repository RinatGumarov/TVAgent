/**
 * TVAgent — content-script side of the page bridge.
 *
 * Content scripts cannot see window.TradingViewApi, so every driver call is a
 * postMessage round trip to src/injected/driver.js, checked by origin and
 * source on both ends.
 */
window.TVAgentBridge = (() => {
  'use strict';

  const REQ = 'tva-req';
  const RES = 'tva-res';
  const EVT = 'tva-evt';
  const ORIGIN = window.location.origin;
  const DEFAULT_TIMEOUT = 45000;

  const pending = new Map();
  const listeners = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const msg = event.data;

    if (msg && msg.source === EVT && typeof msg.type === 'string') {
      (listeners.get(msg.type) || []).forEach((fn) => fn(msg.payload));
      return;
    }

    if (!msg || msg.source !== RES || !pending.has(msg.id)) return;

    const { resolve, reject, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);

    if (msg.ok) resolve(msg.result);
    else reject(new Error(msg.error || 'Driver call failed.'));
  });

  function call(method, params, timeout = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const id = `req_${++seq}_${Date.now()}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Driver call "${method}" timed out after ${timeout}ms.`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: REQ, id, method, params: params || {} }, ORIGIN);
    });
  }

  /** Driver-pushed events. Unlike call(), these arrive unsolicited. */
  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  }

  /**
   * Waits for a report that is actually ready: the driver may load after the
   * panel, and the chart answers only once TradingView has finished loading.
   */
  async function probeWhenReady(attempts = 10) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const report = await call('probe', {}, 4000);
        if (report.ready) return report;
        last = report;
      } catch (e) {
        last = { tradingViewApi: false, warnings: [e.message] };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return last || { tradingViewApi: false, warnings: ['Driver did not respond.'] };
  }

  return { call, on, probeWhenReady };
})();
