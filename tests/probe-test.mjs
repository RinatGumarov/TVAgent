/**
 * The startup capability probe, and the chart events that keep it current,
 * against the real driver.js and bridge.js.
 */
import { check, section, report as summarize } from './helpers/check.mjs';
import { evaluate, makeWorlds, settle, tick } from './helpers/load.mjs';

/**
 * A chart that wakes up late: symbol() answers from the start, resolution()
 * throws what live TradingView throws for the first `flaky` calls. hasBars:
 * false means the bars have not loaded; lastThrows: true guards that a
 * failed price read does not roll report.series back.
 */
function makeChart(flaky, { lastClose = 65432.1, hasBars = true, lastThrows = false } = {}) {
  let calls = 0;
  let symbol = 'BINGX:BTCUSDT.P';
  let resolution = '60';
  const subscribers = { symbol: [], interval: [] };

  const bars = {
    isEmpty: () => !hasBars,
    last: () => {
      if (lastThrows) throw new Error('last() blew up');
      return { value: [1700000000, lastClose - 12, lastClose + 20, lastClose - 30, lastClose, 1234] };
    },
  };
  const series = { data: () => ({ bars: () => bars }) };

  const chart = {
    symbol: () => symbol,
    resolution: () => {
      if (++calls <= flaky) throw new Error('Value is null');
      return resolution;
    },
    getSeries: () => series,
    createStudy() {},
    getAllStudies: () => [],
    createShape() {},
    getStudyById() {},
    studyMetaIntoRepository: () => null,
    onSymbolChanged: () => ({ subscribe: (_o, fn) => subscribers.symbol.push(fn) }),
    onIntervalChanged: () => ({ subscribe: (_o, fn) => subscribers.interval.push(fn) }),
  };

  return {
    api: { activeChart: () => chart, pineEditorTestApi: () => ({}) },
    /** What the user does: switch the symbol, and TradingView tells us. */
    switchTo(nextSymbol, nextResolution) {
      symbol = nextSymbol;
      if (nextResolution) resolution = nextResolution;
      subscribers.symbol.slice().forEach((fn) => fn());
    },
    subscribers,
  };
}

function boot(flaky, chartOpts) {
  const { spawn } = makeWorlds();
  const chart = makeChart(flaky, chartOpts);
  const stubs = { localStorage: { getItem: () => null }, performance: { now: () => 0 }, document: {}, console };

  const main = spawn({ TradingViewApi: chart.api, user: { id: 42 } });
  const iso = spawn({});
  evaluate('shared/wire.js', { window: main, ...stubs });
  evaluate('shared/wait.js', { window: main, ...stubs });
  evaluate('injected/driver.js', { window: main, ...stubs });
  evaluate('shared/wire.js', { window: iso, ...stubs });
  evaluate('shared/wait.js', { window: iso, ...stubs });
  evaluate('content/bridge.js', { window: iso, ...stubs });

  return { bridge: iso.TVAgentBridge, chart };
}

section('the chart does not answer straight away');
{
  const { bridge } = boot(2);
  const r = await bridge.probeWhenReady();
  check('symbol was read', r.symbol, 'BINGX:BTCUSDT.P');
  check('resolution was waited for, not left null', r.resolution, '60');
  check('the report is marked ready', r.ready, true);
  check('no "Chart not ready" warning', (r.warnings || []).filter((w) => /Chart not ready/.test(w)), []);
}

section('the chart never answered');
{
  const { bridge } = boot(Infinity);
  const r = await bridge.probeWhenReady(2);
  check('the report is not ready', !r.ready, true);
  check('but the chart was found — the panel must not claim "no API"', [r.tradingViewApi, r.chart], [true, true]);
  check('the warning is there', (r.warnings || []).some((w) => /Chart not ready/.test(w)), true);
  check('price is absent — the bars were never reached', 'price' in r, false);
}

section('the price in the report');
{
  const { bridge } = boot(0, { lastClose: 65432.1 });
  const r = await bridge.probeWhenReady();
  check('series = true (bars are loaded)', r.series, true);
  check('price is the last close', r.price, 65432.1);
}

section('bars not loaded yet: price is absent, not null');
{
  const { bridge } = boot(0, { hasBars: false });
  const r = await bridge.probeWhenReady();
  check('series = false', r.series, false);
  check('price is absent as a key, not merely undefined', 'price' in r, false);
}

section('the price read fails: series does not roll back with it');
{
  // isEmpty() already said false but last() throws anyway; series must not
  // roll back.
  const { bridge } = boot(0, { lastThrows: true });
  const r = await bridge.probeWhenReady();
  check('series stays true despite the failed price read', r.series, true);
  check('price is absent, and the probe did not fall over', 'price' in r, false);
  check('the report is ready regardless', r.ready, true);
}

section('a symbol change pushes a fresh report');
{
  const { bridge, chart } = boot(0);
  const pushed = [];
  bridge.on('chart-changed', (r) => pushed.push(r));

  const first = await bridge.probeWhenReady();
  check('the probe subscribed to the chart', chart.subscribers.symbol.length > 0, true);
  check('bound to the symbol it started on', first.symbol, 'BINGX:BTCUSDT.P');

  chart.switchTo('NASDAQ:AAPL', 'D');
  // The driver waits out both events and then waits for a report worth
  // sending, so this is not immediate.
  await tick(400);
  await settle();

  check('exactly one report was pushed for one switch', pushed.length, 1);
  check('and it carries the new symbol', [pushed[0]?.symbol, pushed[0]?.resolution], ['NASDAQ:AAPL', 'D']);
  check('still a complete report, not a fragment', pushed[0]?.ready, true);
}

summarize();
