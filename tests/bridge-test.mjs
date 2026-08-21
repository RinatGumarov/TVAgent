/**
 * TVAgent — the page bridge, against the driver it actually talks to.
 *
 * Runs the real bridge.js and the real driver.js in two worlds that share one
 * window, which is the arrangement on a live chart page: a content script and
 * a page script can both post and both listen. A third listener stands in for
 * TradingView's own code.
 *
 * What is expensive to break here is the authentication. The channel is
 * public, so "it came from this origin" says nothing about which script sent
 * it; the handshake in shared/wire.js is what separates our two ends from
 * everything else on the page, and every one of these cases is something that
 * used to work before it existed:
 *
 *   - a page script answering a request it can see, poisoning a tool result;
 *   - a page script invoking a driver method, which includes writing Pine;
 *   - a page script asking for the secret itself.
 *
 * The event channel is checked here too: it is one-way, unsolicited, and was
 * the easiest thing on the wire to forge.
 *
 *   node bridge-test.mjs
 */
import { check, section, report } from './helpers/check.mjs';
import { evaluate, makeWorlds, settle, tick } from './helpers/load.mjs';

/**
 * A chart that answers everything the probe asks, so the round trip under
 * test is the bridge's rather than TradingView's.
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
    TradingViewApi: { activeChart: makeChart, pineEditorTestApi: () => ({}) },
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
  evaluate('shared/wire.js', { window: main, ...stubs });
  evaluate('shared/wait.js', { window: main, ...stubs });
  evaluate('injected/driver.js', { window: main, ...stubs });

  evaluate('shared/wire.js', { window: iso, ...stubs });
  evaluate('shared/wait.js', { window: iso, ...stubs });
  evaluate('content/bridge.js', { window: iso, ...stubs });

  await settle();
  return { main, iso, page, bridge: iso.TVAgentBridge };
}

section('the round trip');

{
  const { bridge } = await boot();
  const report_ = await bridge.call('probe', {});
  check('a call reaches the driver and comes back', [report_.ready, report_.symbol], [true, 'BINANCE:BTCUSDT']);
}

section('a page script cannot answer');

{
  const { page, bridge } = await boot();
  // The request is on a channel the page can read, so its id is not a secret.
  // Answering first is what used to win.
  let sawRequest = false;
  page.addEventListener('message', (e) => {
    if (e.data?.source !== 'tva-req' || sawRequest) return;
    sawRequest = true;
    page.postMessage({ source: 'tva-res', id: e.data.id, ok: true, result: { poisoned: true } });
  });

  const answer = await bridge.call('probe', {});
  check('the page did see the request', sawRequest, true);
  check('but its answer was ignored', answer.poisoned === undefined, true);
  check('and the driver’s answer arrived', answer.ready, true);
}

{
  const { page, bridge } = await boot();
  // Same thing with the stamp field present but wrong — a page script that
  // knows the shape but not the secret.
  page.addEventListener('message', (e) => {
    if (e.data?.source !== 'tva-req') return;
    page.postMessage({ source: 'tva-res', id: e.data.id, stamp: 'x'.repeat(64), ok: true, result: { poisoned: true } });
  });
  const answer = await bridge.call('probe', {});
  check('a wrong stamp is ignored too', answer.poisoned === undefined, true);
}

section('a page script cannot call');

{
  const { main, page } = await boot();
  let answered = null;
  page.addEventListener('message', (e) => {
    if (e.data?.source === 'tva-res' && e.data.id === 'from-the-page') answered = e.data;
  });
  main.postMessage({ source: 'tva-req', id: 'from-the-page', method: 'probe', params: {} });
  await settle();
  check('an unstamped request gets no answer at all', answered, null);
}

/**
 * The case the first version of the stamp did not cover, and the reason this
 * section exists twice. Signing the id alone left the verb and its arguments
 * unsigned, so a page script did not have to forge anything: it read a real
 * request off the wire — every request is public, that is the whole premise —
 * kept the id and the stamp, and swapped `probe` for `set_pine_code`. The
 * stamp verified, because it had never been about the method.
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
  check('the page did see a stamped request', !!(seen && seen.stamp), true);

  answers.length = 0;
  page.postMessage({ ...seen, method: 'set_pine_code', params: { code: 'owned' } });
  await settle();
  check('its stamp does not carry to another method', answers, []);

  answers.length = 0;
  page.postMessage({ ...seen, params: { count: 999 } });
  await settle();
  check('nor to the same method with other arguments', answers, []);
}

section('a page script cannot replay a whole request');

{
  const { page, bridge } = await boot();
  let seen = null;
  const answers = [];
  page.addEventListener('message', (e) => {
    if (e.data?.source === 'tva-req') seen = e.data;
    if (e.data?.source === 'tva-res') answers.push(e.data);
  });
  await bridge.call('probe', {});

  // Byte for byte the request the driver just answered. Stamp and body agree
  // with each other; the id is what has already been spent.
  answers.length = 0;
  page.postMessage({ ...seen });
  await settle();
  check('a request is answered once and not again', answers, []);
}

section('a page script cannot get the secret');

{
  const { main, page } = await boot();
  const secrets = [];
  page.addEventListener('message', (e) => {
    if (e.data?.source === 'tva-hello' && e.data.secret) secrets.push(e.data.nonce);
  });
  main.postMessage({ source: 'tva-hello', nonce: 'page-nonce' });
  await settle();
  check('the driver answers nobody but its first caller', secrets.includes('page-nonce'), false);
}

section('unknown and inherited methods');

for (const method of ['constructor', 'toString', 'hasOwnProperty', 'nope']) {
  const { bridge } = await boot();
  let error = null;
  try {
    await bridge.call(method, {});
  } catch (e) {
    error = e.message;
  }
  check(`"${method}" is not a method`, error, `Unknown method "${method}".`);
}

section('the event channel');

{
  const { main, bridge } = await boot();
  const seen = [];
  bridge.on('widgetbar-active', (p) => seen.push(p));
  bridge.on('widgetbar-active', () => seen.push('second handler'));
  bridge.on('something-else', () => seen.push('wrong type'));

  // Only the driver can stamp an event, and it does that on its own schedule.
  // What the test can do is post the shape of one, which is precisely what a
  // page script trying to drive the panel would send.
  main.postMessage({ source: 'tva-evt', id: 'forged', type: 'widgetbar-active', payload: { active: true } });
  await settle();
  check('an unstamped event is dropped', seen, []);
}

{
  const { iso, bridge } = await boot();
  const seen = [];
  bridge.on('widgetbar-active', (p) => seen.push(p));
  iso.deliver(
    { source: 'tva-evt', id: 'e1', type: 'widgetbar-active', payload: { active: true } },
    'https://evil.example'
  );
  await settle();
  check('a foreign origin is dropped', seen, []);
}

section('a driver that never answers');

{
  const { spawn } = makeWorlds();
  const iso = spawn({});
  const stubs = { localStorage: { getItem: () => null }, performance: { now: () => 0 }, document: {}, console };
  evaluate('shared/wire.js', { window: iso, ...stubs });
  evaluate('shared/wait.js', { window: iso, ...stubs });
  evaluate('content/bridge.js', { window: iso, ...stubs });

  let error = null;
  const call = iso.TVAgentBridge.call('probe', {}).catch((e) => (error = e.message));
  // The handshake gives up after five seconds; nothing here waits that long
  // in real time, so this only checks that the call is still pending rather
  // than resolved against an unauthenticated channel.
  await tick(50);
  check('a call does not resolve without a handshake', error, null);
  check('and nothing was answered in the meantime', await Promise.race([call, Promise.resolve('pending')]), 'pending');
}

report();
