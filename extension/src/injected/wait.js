/**
 * TVAgent — waiting for something the host does on its own schedule.
 *
 * There were four of these written by hand, each with a different idea of when
 * to check, how long to wait and what to return when the thing never came.
 * This is the one shape: check, then sleep, up to `attempts` checks.
 *
 * Both worlds use it, so both worlds get a copy — see shared/wire.js for why
 * the manifest cannot simply name this file twice.
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
