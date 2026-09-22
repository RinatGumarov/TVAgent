/** What the bundler produces has to be loadable, and split by world. */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeWorlds, settle } from './helpers/load.mjs';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build/extension');

describe('the build produces a loadable extension', () => {
  before(() => {
    execFileSync('node', ['tools/build.mjs'], { cwd: root, stdio: 'pipe' });
  });

  it('every file the manifest names is there', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const declared = [
      manifest.background.service_worker,
      ...(manifest.content_scripts || []).flatMap((e) => [...(e.js || []), ...(e.css || [])]),
      ...Object.values(manifest.icons || {}),
    ];
    assert.deepStrictEqual(
      declared.filter((rel) => !fs.existsSync(path.join(out, rel))),
      [],
    );
  });

  // One authored wire, one copy per world: what sync-worlds.sh used to fake.
  it('both worlds carry their own copy of the wire', () => {
    const carries = (name) => fs.readFileSync(path.join(out, name), 'utf8').includes('tva-hello');
    assert.deepStrictEqual([carries('driver.js'), carries('bridge.js')], [true, true]);
  });
});

/** Enough of TradingView's API for the startup probe to complete. */
function makeChartApi() {
  const bars = {
    isEmpty: () => false,
    last: () => ({ value: [1700000000, 1, 2, 0.5, 65000, 10] }),
  };
  const chart = {
    symbol: () => 'BINANCE:BTCUSDT',
    resolution: () => '60',
    getSeries: () => ({ data: () => ({ bars: () => bars }) }),
    createStudy() {},
    getAllStudies: () => [],
    createShape() {},
    getStudyById() {},
    studyMetaIntoRepository: () => null,
    onSymbolChanged: () => ({ subscribe: () => {} }),
    onIntervalChanged: () => ({ subscribe: () => {} }),
  };
  return { activeChart: () => chart, pineEditorApi: () => ({}) };
}

describe('the shipped bundles talk to each other', () => {
  before(() => {
    execFileSync('node', ['tools/build.mjs'], { cwd: root, stdio: 'pipe' });
  });

  // The unit suites bundle from source; this one runs the files that ship, in
  // two worlds sharing one window, which is what the handshake exists for.
  it('the handshake completes and a probe comes back', async () => {
    const { spawn } = makeWorlds();
    const stubs = {
      localStorage: { getItem: () => null },
      performance: { now: () => 0 },
      document: {},
      console,
    };
    const run = (name, scope) => {
      const code = fs.readFileSync(path.join(out, name), 'utf8');
      const keys = Object.keys(scope);
      new Function(...keys, code)(...keys.map((k) => scope[k]));
    };

    const main = spawn({ TradingViewApi: makeChartApi(), user: { id: 1 } });
    const iso = spawn({});
    run('driver.js', { window: main, globalThis: main, ...stubs });
    run('bridge.js', { window: iso, globalThis: iso, ...stubs });
    await settle();

    const report = await iso.TVAgentBridge.probeWhenReady();
    assert.deepStrictEqual(
      [report.ready, report.symbol, report.resolution],
      [true, 'BINANCE:BTCUSDT', '60'],
    );
  });
});
