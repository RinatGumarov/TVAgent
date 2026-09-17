/**
 * TVAgent — content-script side of the page bridge.
 *
 * Content scripts cannot see window.TradingViewApi, so every driver call is a
 * postMessage round trip to src/injected/driver.js. The channel is shared with
 * every script on the page; a message without a stamp from the handshake in
 * shared/wire.js is ignored.
 */
import * as wire from '../shared/wire.ts';
import { poll } from '../shared/wait.ts';
import type { Bridge, BridgeEvents, PartialProbeReport, ProbeReport } from '../shared/protocol.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One bridge, handshake started. The entry hands it to the panel bundle. */
export function createBridge(): Bridge {
  const ORIGIN = window.location.origin;
  const DEFAULT_TIMEOUT = 45000;

  // The driver is injected alongside us, so a handshake that has not finished
  // in this long is not slow — it is not happening.
  const HANDSHAKE_TIMEOUT = 5000;

  const pending = new Map<string, Pending>();
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  // ------------------------------------------------------------- handshake

  const nonce = wire.id();
  let key: CryptoKey | null = null;

  let settleKey!: (value: CryptoKey) => void;
  let failKey!: (err: Error) => void;
  const authorized = new Promise<CryptoKey>((resolve, reject) => {
    settleKey = resolve;
    failKey = reject;
  });
  // Nothing awaits this until the first call(), and an unobserved rejection in
  // between is noise, not news.
  authorized.catch(() => {});

  function hello() {
    window.postMessage({ source: wire.HELLO, nonce }, ORIGIN);
  }

  async function adopt(secret: string) {
    if (key) return;
    key = await wire.key(secret);
    settleKey(key);
  }

  // Asked once, and again only when a late driver announces itself; a retry
  // timer would broadcast the nonce into a running page.
  hello();
  setTimeout(() => {
    if (key) return;
    failKey(new Error('The TVAgent page driver did not answer — reload the chart page.'));
  }, HANDSHAKE_TIMEOUT);

  // --------------------------------------------------------------- inbound

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.source === wire.HELLO) {
      // Our own hello comes back to us too; only the driver's answer carries a
      // secret, and only for the nonce we asked with.
      if (msg.nonce === nonce && typeof msg.secret === 'string') await adopt(msg.secret);
      // The driver announces itself when it loads after us — that is the cue
      // to ask again rather than wait out the retry interval.
      else if (msg.announce && !key) hello();
      return;
    }

    if (!key) return;

    if (msg.source === wire.EVT && typeof msg.type === 'string') {
      const expected = await wire.stamp(key, msg.id, 'evt', wire.body(msg.type, msg.payload));
      if (msg.stamp !== expected) return;
      (listeners.get(msg.type) || []).forEach((fn) => fn(msg.payload));
      return;
    }

    if (msg.source !== wire.RES || !pending.has(msg.id)) return;
    // A page script can read the id off the request but cannot make this
    // stamp.
    if (msg.stamp !== (await wire.stamp(key, msg.id, 'res'))) return;

    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'Driver call failed.'));
  });

  // -------------------------------------------------------------- outbound

  async function call<T>(method: string, params?: object, timeout = DEFAULT_TIMEOUT): Promise<T> {
    const signingKey = key || (await authorized);
    const id = wire.id();
    // The driver re-derives the stamp from the params it received, so sign
    // exactly what goes on the wire.
    const sent = params || {};
    const stamp = await wire.stamp(signingKey, id, 'req', wire.body(method, sent));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Driver call "${method}" timed out after ${timeout}ms.`));
      }, timeout);
      pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer });
      window.postMessage({ source: wire.REQ, id, stamp, method, params: sent }, ORIGIN);
    });
  }

  /** Driver-pushed events. Unlike call(), these arrive unsolicited. */
  function on<K extends keyof BridgeEvents>(type: K, handler: (payload: BridgeEvents[K]) => void) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(handler as (payload: unknown) => void);
  }

  /**
   * Waits for a report that is actually ready: the driver may load after the
   * panel, and the chart answers only once TradingView has finished loading.
   */
  async function probeWhenReady(attempts = 10): Promise<ProbeReport | PartialProbeReport> {
    let last: ProbeReport | PartialProbeReport | null = null;
    const ready = await poll(
      async () => {
        try {
          last = await call<ProbeReport>('probe', {}, 4000);
          return last.ready ? last : null;
        } catch (e) {
          last = { tradingViewApi: false, warnings: [(e as Error).message] };
          return null;
        }
      },
      { attempts, intervalMs: 1000 },
    );
    return ready || last || { tradingViewApi: false, warnings: ['Driver did not respond.'] };
  }

  return { call, on, probeWhenReady };
}
