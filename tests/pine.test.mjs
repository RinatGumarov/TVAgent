/**
 * The Pine tools against the real driver.js and bridge.js, with TradingView's
 * pineEditorApi (and the older pineEditorTestApi) stood in for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, makeWorlds, settle } from './helpers/load.mjs';

const CODE = '//@version=6\nstrategy("EMA 50/200")';

/**
 * A Pine Editor. `open` is where one is already showing ('dialog', 'bottom'
 * or null); `saved` means it holds one of the user's saved scripts;
 * `unmounted` is how many setScript calls do nothing, as on a fresh editor.
 */
function makePine({ open = 'dialog', saved = false, unmounted = 0 } = {}) {
  const studies = [];
  const log = [];
  const facade = {
    placement: open || 'dialog',
    draft: !saved,
    source: saved ? 'the user script' : '',
    isDraft: () => facade.draft,
    isModified: () => false,
    async openNewScript() {
      log.push('new');
      facade.draft = true;
      facade.source = 'template';
    },
    async setScript(code) {
      if (unmounted-- > 0) return;
      facade.source = code;
    },
    async getSource() {
      return facade.source;
    },
    async addToChart() {
      log.push('add');
      studies.push({ id: 'st1', name: 'EMA 50/200' });
    },
  };
  const shown = { dialog: open === 'dialog', bottom: open === 'bottom' };
  const pineApi = {
    async open(options) {
      log.push(['open', options]);
      shown.dialog = true;
    },
    getDialogFacade: () => (shown.dialog ? facade : null),
    getBottomFacade: () => (shown.bottom ? facade : null),
  };
  return { facade, pineApi, studies, log };
}

function makeChart(studies = []) {
  return {
    symbol: () => 'BINANCE:BTCUSDT',
    resolution: () => '60',
    getSeries: () => ({ data: () => ({ bars: () => ({ isEmpty: () => true }) }) }),
    createStudy() {},
    getAllStudies: () => studies.slice(),
    createShape() {},
    getStudyById: () => ({}),
    onSymbolChanged: () => ({ subscribe: () => {} }),
    onIntervalChanged: () => ({ subscribe: () => {} }),
  };
}

async function boot(tvApi) {
  const { spawn } = makeWorlds();
  const stubs = {
    localStorage: { getItem: () => null },
    performance: { now: () => 0 },
    document: { querySelector: () => null },
    console,
  };
  const main = spawn({ TradingViewApi: tvApi, user: { id: 1 } });
  const iso = spawn({});
  loadModule('entries/driver.ts', { window: main, ...stubs });
  loadModule('entries/bridge.ts', { window: iso, ...stubs });
  await settle();
  return iso.TVAgentBridge;
}

function withPine(opts) {
  const pine = makePine(opts);
  const tvApi = { activeChart: () => makeChart(pine.studies), pineEditorApi: () => pine.pineApi };
  return { pine, tvApi };
}

describe('set_pine_code with the editor closed', async () => {
  const { pine, tvApi } = withPine({ open: null });
  const bridge = await boot(tvApi);
  const r = await bridge.call('set_pine_code', { code: CODE });

  it('opens the editor in the side panel, not a new tab', () => {
    assert.deepStrictEqual(pine.log[0], ['open', { placement: 'dialog', forceOpen: true }]);
  });

  it('puts the code in it', () => {
    assert.deepStrictEqual(pine.facade.source, CODE);
  });

  it('reports the length', () => {
    assert.deepStrictEqual(r, { ok: true, length: CODE.length });
  });
});

describe('set_pine_code with a saved script open', async () => {
  const { pine, tvApi } = withPine({ saved: true });
  const bridge = await boot(tvApi);
  await bridge.call('set_pine_code', { code: CODE });

  it('opens a new script first', () => {
    assert.deepStrictEqual(pine.log, ['new']);
  });

  it('and writes there', () => {
    assert.deepStrictEqual([pine.facade.draft, pine.facade.source], [true, CODE]);
  });
});

describe('set_pine_code with a draft open', async () => {
  const { pine, tvApi } = withPine({ open: 'bottom' });
  const bridge = await boot(tvApi);
  await bridge.call('set_pine_code', { code: CODE });

  it('reuses the open editor as it is', () => {
    assert.deepStrictEqual([pine.log, pine.facade.source], [[], CODE]);
  });
});

describe('set_pine_code before the editor has mounted', async () => {
  const { pine, tvApi } = withPine({ unmounted: 2 });
  const bridge = await boot(tvApi);
  await bridge.call('set_pine_code', { code: CODE });

  it('retries until the code is in', () => {
    assert.deepStrictEqual(pine.facade.source, CODE);
  });
});

describe('add_pine_to_chart', async () => {
  const { pine, tvApi } = withPine();
  const bridge = await boot(tvApi);
  const r = await bridge.call('add_pine_to_chart', {});

  it('adds through the editor', () => {
    assert.deepStrictEqual(pine.log, ['add']);
  });

  it('returns the new study', () => {
    assert.deepStrictEqual([r.ok, r.id, r.name], [true, 'st1', 'EMA 50/200']);
  });
});

describe('open_pine_editor', async () => {
  const { pine, tvApi } = withPine({ open: null });
  const bridge = await boot(tvApi);
  const r = await bridge.call('open_pine_editor', {});

  it('opens the editor with a new script', () => {
    assert.deepStrictEqual(pine.log.at(-1), 'new');
  });

  it('says so', () => {
    assert.deepStrictEqual(r, { open: true, newScript: true });
  });
});

describe('the older pineEditorTestApi', async () => {
  const calls = [];
  const studies = [];
  const tvApi = {
    activeChart: () => makeChart(studies),
    pineEditorTestApi: () => ({
      openEditor: async () => calls.push('openEditor'),
      openNewScript: async () => calls.push('openNewScript'),
      setEditorText: async (code) => calls.push(['setEditorText', code]),
      addScriptOnChart: async () => {
        calls.push('addScriptOnChart');
        studies.push({ id: 'old1', name: 'Old' });
      },
    }),
  };
  const bridge = await boot(tvApi);
  const report = await bridge.call('probe', {});
  await bridge.call('open_pine_editor', {});
  await bridge.call('set_pine_code', { code: CODE });
  const added = await bridge.call('add_pine_to_chart', {});

  it('still counts as Pine support', () => {
    assert.deepStrictEqual(report.pine, true);
  });

  it('drives the old methods', () => {
    assert.deepStrictEqual(calls, [
      'openEditor',
      'openNewScript',
      ['setEditorText', CODE],
      'addScriptOnChart',
    ]);
  });

  it('and the study is found', () => {
    assert.deepStrictEqual(added.id, 'old1');
  });
});

describe('the probe', async () => {
  const withNew = await (await boot(withPine().tvApi)).call('probe', {});
  const without = await (await boot({ activeChart: () => makeChart() })).call('probe', {});

  it('pine = true with pineEditorApi', () => {
    assert.deepStrictEqual(withNew.pine, true);
  });

  it('pine = false with neither API', () => {
    assert.deepStrictEqual(without.pine, false);
  });

  it('and a warning says why', () => {
    assert.ok(without.warnings.some((w) => /Pine Editor API unavailable/.test(w)));
  });
});
