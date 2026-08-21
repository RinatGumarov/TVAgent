/**
 * TVAgent — one poll helper for everything that waits on the host. Both worlds
 * load a copy; see shared/wire.js for why.
 */
(() => {
  'use strict';

  /**
   * @param {() => any} check  a truthy return (awaited) ends the wait
   * @param {{attempts: number, intervalMs: number}} opts
   * @returns {Promise<any>} the first truthy value, or null if it never came
   */
  async function poll(check, { attempts, intervalMs }) {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      const value = await check();
      if (value) return value;
    }
    return null;
  }

  globalThis.TVAgentWait = { poll };
})();
