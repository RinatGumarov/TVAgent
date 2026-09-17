/**
 * The startup capability probe, and the chart events that keep it current,
 * against the real driver.js and bridge.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, makeWorlds, settle, tick } from './helpers/load.mjs';

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
      return {
        value: [1700000000, lastClose - 12, lastClose + 20, lastClose - 30, lastClose, 1234],
      };
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
  const stubs = {
    localStorage: { getItem: () => null },
    performance: { now: () => 0 },
    document: {},
    console,
  };

  const main = spawn({ TradingViewApi: chart.api, user: { id: 42 } });
  const iso = spawn({});
  loadModule('entries/driver.js', { window: main, ...stubs });
  loadModule('entries/bridge.js', { window: iso, ...stubs });

  return { bridge: iso.TVAgentBridge, chart };
}

describe('the chart does not answer straight away', async () => {
  const { bridge } = boot(2);
  const r = await bridge.probeWhenReady();

  it('symbol was read', () => {
    assert.deepStrictEqual(r.symbol, 'BINGX:BTCUSDT.P');
  });

  it('resolution was waited for, not left null', () => {
    assert.deepStrictEqual(r.resolution, '60');
  });

  it('the report is marked ready', () => {
    assert.deepStrictEqual(r.ready, true);
  });

  it('no "Chart not ready" warning', () => {
    assert.deepStrictEqual(
      (r.warnings || []).filter((w) => /Chart not ready/.test(w)),
      [],
    );
  });
});

describe('the chart never answered', async () => {
  const { bridge } = boot(Infinity);
  const r = await bridge.probeWhenReady(2);

  it('the report is not ready', () => {
    assert.deepStrictEqual(r.ready, false);
  });

  it('but the chart was found — the panel must not claim "no API"', () => {
    assert.deepStrictEqual([r.tradingViewApi, r.chart], [true, true]);
  });

  it('the warning is there', () => {
    assert.ok((r.warnings || []).some((w) => /Chart not ready/.test(w)));
  });

  it('price is absent — the bars were never reached', () => {
    assert.deepStrictEqual('price' in r, false);
  });
});

describe('the price in the report', async () => {
  const { bridge } = boot(0, { lastClose: 65432.1 });
  const r = await bridge.probeWhenReady();

  it('series = true (bars are loaded)', () => {
    assert.deepStrictEqual(r.series, true);
  });

  it('price is the last close', () => {
    assert.deepStrictEqual(r.price, 65432.1);
  });
});

describe('bars not loaded yet: price is absent, not null', async () => {
  const { bridge } = boot(0, { hasBars: false });
  const r = await bridge.probeWhenReady();

  it('series = false', () => {
    assert.deepStrictEqual(r.series, false);
  });

  it('price is absent as a key, not merely undefined', () => {
    assert.deepStrictEqual('price' in r, false);
  });
});

describe('the price read fails: series does not roll back with it', async () => {
  // isEmpty() already said false but last() throws anyway; series must not
  // roll back.
  const { bridge } = boot(0, { lastThrows: true });
  const r = await bridge.probeWhenReady();

  it('series stays true despite the failed price read', () => {
    assert.deepStrictEqual(r.series, true);
  });

  it('price is absent, and the probe did not fall over', () => {
    assert.deepStrictEqual('price' in r, false);
  });

  it('the report is ready regardless', () => {
    assert.deepStrictEqual(r.ready, true);
  });
});

describe('a symbol change pushes a fresh report', async () => {
  const { bridge, chart } = boot(0);
  const pushed = [];
  bridge.on('chart-changed', (r) => pushed.push(r));

  const first = await bridge.probeWhenReady();
  const subscribedAtOnce = chart.subscribers.symbol.length > 0;

  chart.switchTo('NASDAQ:AAPL', 'D');
  // The driver waits out both events and then waits for a report worth
  // sending, so this is not immediate.
  await tick(400);
  await settle();

  it('the probe subscribed to the chart', () => {
    assert.ok(subscribedAtOnce);
  });

  it('bound to the symbol it started on', () => {
    assert.deepStrictEqual(first.symbol, 'BINGX:BTCUSDT.P');
  });

  it('exactly one report was pushed for one switch', () => {
    assert.deepStrictEqual(pushed.length, 1);
  });

  it('and it carries the new symbol', () => {
    assert.deepStrictEqual([pushed[0]?.symbol, pushed[0]?.resolution], ['NASDAQ:AAPL', 'D']);
  });

  it('still a complete report, not a fragment', () => {
    assert.deepStrictEqual(pushed[0]?.ready, true);
  });
});
