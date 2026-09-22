/**
 * Runs the real bridge.js and driver.js in two worlds that share one window,
 * with a third listener standing in for TradingView's own scripts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, makeWorlds, settle, tick } from './helpers/load.mjs';

/**
 * A chart that answers everything the probe asks, so the round trip under
 * test is the bridge's.
 */
function makeChart() {
  return {
    symbol: () => 'BINANCE:BTCUSDT',
    resolution: () => '240',
    createStudy: () => {},
    getAllStudies: () => [],
    createShape: () => {},
    getStudyById: () => ({}),
    getSeries: () => ({ data: () => ({ bars: () => ({ isEmpty: () => true }) }) }),
    onSymbolChanged: () => ({ subscribe: () => {} }),
    onIntervalChanged: () => ({ subscribe: () => {} }),
  };
}

/** Both worlds, both real modules, wired the way the manifest wires them. */
async function boot() {
  const { spawn } = makeWorlds();

  const main = spawn({
    TradingViewApi: { activeChart: makeChart, pineEditorApi: () => ({}) },
    user: { id: 1 },
  });
  const iso = spawn({});
  const page = spawn({}); // TradingView's own scripts

  const stubs = {
    localStorage: { getItem: () => null },
    performance: { now: () => 0 },
    document: { querySelector: () => null },
    console,
  };
  loadModule('entries/driver.ts', { window: main, ...stubs });
  loadModule('entries/bridge.ts', { window: iso, ...stubs });

  await settle();
  return { main, iso, page, bridge: iso.TVAgentBridge };
}

describe('the round trip', async () => {
  {
    const { bridge } = await boot();
    const report_ = await bridge.call('probe', {});
    const got1 = [report_.ready, report_.symbol];
    const want1 = [true, 'BINANCE:BTCUSDT'];
    it('a call reaches the driver and comes back', () => {
      assert.deepStrictEqual(got1, want1);
    });
  }
});

describe('a page script cannot answer', async () => {
  {
    const { page, bridge } = await boot();
    // The request is on a channel the page can read, so its id is not a secret.
    let sawRequest = false;
    page.addEventListener('message', (e) => {
      if (e.data?.source !== 'tva-req' || sawRequest) return;
      sawRequest = true;
      page.postMessage({ source: 'tva-res', id: e.data.id, ok: true, result: { poisoned: true } });
    });

    const answer = await bridge.call('probe', {});
    const got2 = sawRequest;
    const want2 = true;
    it('the page did see the request', () => {
      assert.deepStrictEqual(got2, want2);
    });
    const got3 = answer.poisoned === undefined;
    const want3 = true;
    it('but its answer was ignored', () => {
      assert.deepStrictEqual(got3, want3);
    });
    const got4 = answer.ready;
    const want4 = true;
    it('and the driver’s answer arrived', () => {
      assert.deepStrictEqual(got4, want4);
    });
  }

  {
    const { page, bridge } = await boot();
    // The stamp field present but wrong: a page script that knows the shape but
    // not the secret.
    page.addEventListener('message', (e) => {
      if (e.data?.source !== 'tva-req') return;
      page.postMessage({
        source: 'tva-res',
        id: e.data.id,
        stamp: 'x'.repeat(64),
        ok: true,
        result: { poisoned: true },
      });
    });
    const answer = await bridge.call('probe', {});
    const got5 = answer.poisoned === undefined;
    const want5 = true;
    it('a wrong stamp is ignored too', () => {
      assert.deepStrictEqual(got5, want5);
    });
  }
});

describe('a page script cannot call', async () => {
  {
    const { main, page } = await boot();
    let answered = null;
    page.addEventListener('message', (e) => {
      if (e.data?.source === 'tva-res' && e.data.id === 'from-the-page') answered = e.data;
    });
    main.postMessage({ source: 'tva-req', id: 'from-the-page', method: 'probe', params: {} });
    await settle();
    const got6 = answered;
    const want6 = null;
    it('an unstamped request gets no answer at all', () => {
      assert.deepStrictEqual(got6, want6);
    });
  }

  /**
   * A stamp covers the verb and its arguments, not just the id: a page script
   * can lift a real request off the wire and swap the method.
   */
  {
    const { page, bridge } = await boot();
    let seen = null;
    const answers = [];
    page.addEventListener('message', (e) => {
      if (e.data?.source === 'tva-req') seen = e.data;
      if (e.data?.source === 'tva-res') answers.push(e.data);
    });
    await bridge.call('probe', {});
    const got7 = !!(seen && seen.stamp);
    const want7 = true;
    it('the page did see a stamped request', () => {
      assert.deepStrictEqual(got7, want7);
    });

    answers.length = 0;
    page.postMessage({ ...seen, method: 'set_pine_code', params: { code: 'owned' } });
    await settle();
    const got8 = answers;
    const want8 = [];
    it('its stamp does not carry to another method', () => {
      assert.deepStrictEqual(got8, want8);
    });

    answers.length = 0;
    page.postMessage({ ...seen, params: { count: 999 } });
    await settle();
    const got9 = answers;
    const want9 = [];
    it('nor to the same method with other arguments', () => {
      assert.deepStrictEqual(got9, want9);
    });
  }
});

describe('a page script cannot replay a whole request', async () => {
  {
    const { page, bridge } = await boot();
    let seen = null;
    const answers = [];
    page.addEventListener('message', (e) => {
      if (e.data?.source === 'tva-req') seen = e.data;
      if (e.data?.source === 'tva-res') answers.push(e.data);
    });
    await bridge.call('probe', {});

    // Byte for byte the request the driver just answered; the id has already
    // been spent.
    answers.length = 0;
    page.postMessage({ ...seen });
    await settle();
    const got10 = answers;
    const want10 = [];
    it('a request is answered once and not again', () => {
      assert.deepStrictEqual(got10, want10);
    });
  }
});

describe('a page script cannot get the secret', async () => {
  {
    const { main, page } = await boot();
    const secrets = [];
    page.addEventListener('message', (e) => {
      if (e.data?.source === 'tva-hello' && e.data.secret) secrets.push(e.data.nonce);
    });
    main.postMessage({ source: 'tva-hello', nonce: 'page-nonce' });
    await settle();
    const got11 = secrets.includes('page-nonce');
    const want11 = false;
    it('the driver answers nobody but its first caller', () => {
      assert.deepStrictEqual(got11, want11);
    });
  }
});

describe('unknown and inherited methods', async () => {
  for (const method of ['constructor', 'toString', 'hasOwnProperty', 'nope']) {
    const { bridge } = await boot();
    let error = null;
    try {
      await bridge.call(method, {});
    } catch (e) {
      error = e.message;
    }
    const got12 = error;
    const want12 = `Unknown method "${method}".`;
    it(`"${method}" is not a method`, () => {
      assert.deepStrictEqual(got12, want12);
    });
  }
});

describe('the event channel', async () => {
  {
    const { main, bridge } = await boot();
    const seen = [];
    bridge.on('widgetbar-active', (p) => seen.push(p));
    bridge.on('widgetbar-active', () => seen.push('second handler'));
    bridge.on('something-else', () => seen.push('wrong type'));

    // Only the driver can stamp an event; this posts the shape of one, as a
    // page script would.
    main.postMessage({
      source: 'tva-evt',
      id: 'forged',
      type: 'widgetbar-active',
      payload: { active: true },
    });
    await settle();
    const got13 = seen;
    const want13 = [];
    it('an unstamped event is dropped', () => {
      assert.deepStrictEqual(got13, want13);
    });
  }

  {
    const { iso, bridge } = await boot();
    const seen = [];
    bridge.on('widgetbar-active', (p) => seen.push(p));
    iso.deliver(
      { source: 'tva-evt', id: 'e1', type: 'widgetbar-active', payload: { active: true } },
      'https://evil.example',
    );
    await settle();
    const got14 = seen;
    const want14 = [];
    it('a foreign origin is dropped', () => {
      assert.deepStrictEqual(got14, want14);
    });
  }
});

describe('a driver that never answers', async () => {
  {
    const { spawn } = makeWorlds();
    const iso = spawn({});
    const stubs = {
      localStorage: { getItem: () => null },
      performance: { now: () => 0 },
      document: {},
      console,
    };
    loadModule('entries/bridge.ts', { window: iso, ...stubs });

    let error = null;
    const call = iso.TVAgentBridge.call('probe', {}).catch((e) => (error = e.message));
    // The handshake gives up after five seconds; this only checks that the call
    // is still pending rather than resolved against an unauthenticated channel.
    await tick(50);
    const got15 = error;
    const want15 = null;
    it('a call does not resolve without a handshake', () => {
      assert.deepStrictEqual(got15, want15);
    });
    const got16 = await Promise.race([call, Promise.resolve('pending')]);
    const want16 = 'pending';
    it('and nothing was answered in the meantime', () => {
      assert.deepStrictEqual(got16, want16);
    });
  }
});
