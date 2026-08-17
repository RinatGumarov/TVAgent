/**
 * TVAgent — page-context driver.
 *
 * Runs in the MAIN world so it can reach `window.TradingViewApi`, the semantic
 * API TradingView exposes on chart pages (see docs/internal-api-map.md).
 *
 * Talks to the extension's content script over window.postMessage. Only the
 * method names in HANDLERS can be invoked — the LLM never reaches arbitrary JS.
 */
(() => {
  'use strict';

  const REQ = 'tva-req';
  const RES = 'tva-res';
  const ORIGIN = window.location.origin;

  const log = (...a) => {
    if (localStorage.getItem('tv-agent-debug') === '1') console.log('[TVAgent/page]', ...a);
  };

  // ---------------------------------------------------------------- helpers

  function api() {
    const a = window.TradingViewApi;
    if (!a) throw new Error('TradingViewApi is not available on this page yet.');
    return a;
  }

  function chart() {
    const c = api().activeChart();
    if (!c) throw new Error('No active chart.');
    return c;
  }

  /** Loaded OHLCV window. TradingView keeps ~300 bars in memory. */
  function bars() {
    const b = chart().getSeries().data().bars();
    if (!b || b.isEmpty()) throw new Error('No bar data loaded yet — wait for the chart to finish loading.');
    return b;
  }

  /** [time, open, high, low, close, volume] */
  function barAt(index) {
    const v = bars().valueAt(index);
    if (!v) throw new Error(`No bar at index ${index}.`);
    return v;
  }

  /**
   * Drawing points must land on a loaded bar — an arbitrary timestamp makes
   * createShape throw a bare "Value is null" from deep inside the converter.
   */
  function snapToBar(time) {
    const b = bars();
    const first = b.valueAt(b.firstIndex())[0];
    const last = b.valueAt(b.lastIndex())[0];
    if (time == null) return last;
    if (time <= first) return first;
    if (time >= last) return last;
    let best = last;
    let bestDist = Infinity;
    for (let i = b.firstIndex(); i <= b.lastIndex(); i++) {
      const v = b.valueAt(i);
      if (!v) continue;
      const d = Math.abs(v[0] - time);
      if (d < bestDist) { bestDist = d; best = v[0]; }
    }
    return best;
  }

  function studyCatalog() {
    const repo = chart().studyMetaIntoRepository();
    if (!repo || !repo.getInternalMetaInfoArray) return [];
    return repo.getInternalMetaInfoArray().map((m) => ({
      id: m.id,
      name: m.description,
      short: m.shortDescription,
    }));
  }

  function findStudyName(query) {
    const all = studyCatalog();
    const q = String(query).trim().toLowerCase();
    const exact = all.find((s) => (s.name || '').toLowerCase() === q);
    if (exact) return exact.name;
    // Common shorthand the model is likely to produce.
    const aliases = {
      'ema': 'Moving Average Exponential',
      'sma': 'Moving Average',
      'ma': 'Moving Average',
      'wma': 'Moving Average Weighted',
      'hma': 'Hull Moving Average',
      'vwap': 'VWAP',
      'bb': 'Bollinger Bands',
      'rsi': 'Relative Strength Index',
      'macd': 'MACD',
      'atr': 'Average True Range',
      'stoch': 'Stochastic',
    };
    if (aliases[q]) {
      const hit = all.find((s) => (s.name || '').toLowerCase() === aliases[q].toLowerCase());
      if (hit) return hit.name;
    }
    const partial = all.find((s) => (s.name || '').toLowerCase().includes(q));
    if (partial) return partial.name;
    throw new Error(
      `Unknown indicator "${query}". Call search_indicators first to get an exact name.`
    );
  }

  function studySummary(entity) {
    const out = { id: entity.id, name: entity.name };
    try {
      const s = chart().getStudyById(entity.id);
      out.inputs = s.getInputValues ? s.getInputValues() : undefined;
      if (s.hasError && s.hasError()) out.error = true;
    } catch (_) { /* study may still be building */ }
    return out;
  }

  // ---------------------------------------------------------------- handlers

  const HANDLERS = {
    /** Startup capability probe — plan §19. */
    async probe() {
      const report = {
        tradingViewApi: typeof window.TradingViewApi === 'object' && !!window.TradingViewApi,
        loggedIn: false,
        chart: false,
        // `chart` only means the object exists; `ready` means it answers.
        ready: false,
        series: false,
        studies: false,
        drawings: false,
        pine: false,
        strategy: false,
        symbol: null,
        resolution: null,
        warnings: [],
      };

      if (!report.tradingViewApi) {
        report.warnings.push('TradingViewApi not found. Open a chart page (tradingview.com/chart/).');
        return report;
      }

      try {
        report.loggedIn = !!(window.user && window.user.id);
      } catch (_) { /* ignore */ }
      if (!report.loggedIn) {
        report.warnings.push(
          'You appear to be logged out. Most drawing tools are unavailable to anonymous users ' +
          'and will fail with "Cannot create ... shape". Log in to TradingView.'
        );
      }

      try {
        const c = chart();
        report.chart = true;
        // The chart object exists long before it can answer: while TradingView
        // is still loading, both of these throw a bare "Value is null" from
        // deep inside it. That is why the caller waits on `ready`, not `chart`.
        report.symbol = c.symbol();
        report.resolution = c.resolution();
        report.studies = typeof c.createStudy === 'function' && typeof c.getAllStudies === 'function';
        report.drawings = typeof c.createShape === 'function';
        report.strategy = typeof c.getStudyById === 'function';
        try { report.series = !bars().isEmpty(); } catch (_) { report.series = false; }
      } catch (e) {
        report.warnings.push('Chart not ready: ' + e.message);
      }
      report.ready = report.chart && !!report.symbol && report.resolution != null;

      try {
        report.pine = typeof api().pineEditorTestApi === 'function' && !!api().pineEditorTestApi();
      } catch (_) {
        report.pine = false;
        report.warnings.push('Pine Editor API unavailable — Pine tools are disabled.');
      }

      return report;
    },

    // ---- context ----------------------------------------------------------

    async get_chart_context() {
      const c = chart();
      const ctx = {
        symbol: c.symbol(),
        timeframe: c.resolution(),
        chartType: c.chartType(),
        visibleRange: c.getVisibleRange(),
        indicators: c.getAllStudies().map(studySummary),
        drawings: c.getAllShapes(),
      };
      try {
        const b = bars();
        const last = b.last().value;
        ctx.lastBar = { time: last[0], open: last[1], high: last[2], low: last[3], close: last[4], volume: last[5] };
        ctx.loadedBars = b.size();
      } catch (_) { ctx.loadedBars = 0; }
      try {
        const ext = c.symbolExt();
        if (ext) ctx.description = ext.description || ext.full_name;
      } catch (_) { /* ignore */ }
      return ctx;
    },

    async get_series_data({ count = 100 } = {}) {
      const b = bars();
      const n = Math.max(1, Math.min(Number(count) || 100, b.size()));
      const out = [];
      for (let i = b.lastIndex() - n + 1; i <= b.lastIndex(); i++) {
        const v = b.valueAt(i);
        if (!v) continue;
        out.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] });
      }

      // Scanning a hundred bars for an extreme is arithmetic, and models get it
      // wrong often enough to draw a line at the wrong price. Compute it here
      // so the range is a fact the model reads rather than a sum it does.
      let high = out[0], low = out[0];
      for (const bar of out) {
        if (bar.high > high.high) high = bar;
        if (bar.low < low.low) low = bar;
      }

      return {
        symbol: chart().symbol(),
        timeframe: chart().resolution(),
        count: out.length,
        range: {
          high: { price: high.high, time: high.time },
          low: { price: low.low, time: low.time },
          first: { time: out[0].time, open: out[0].open },
          last: { time: out.at(-1).time, close: out.at(-1).close },
        },
        bars: out,
      };
    },

    // ---- chart ------------------------------------------------------------

    async set_symbol({ symbol }) {
      if (!symbol) throw new Error('symbol is required');
      const ok = await chart().setSymbol(String(symbol));
      if (!ok) throw new Error(`TradingView rejected symbol "${symbol}".`);
      return { symbol: chart().symbol(), timeframe: chart().resolution() };
    },

    async set_timeframe({ timeframe }) {
      if (!timeframe) throw new Error('timeframe is required');
      const ok = await chart().setResolution(String(timeframe));
      if (!ok) throw new Error(`TradingView rejected timeframe "${timeframe}".`);
      return { symbol: chart().symbol(), timeframe: chart().resolution() };
    },

    async set_visible_range({ from, to }) {
      await chart().setVisibleRange({ from: Number(from), to: Number(to) });
      return { visibleRange: chart().getVisibleRange() };
    },

    // ---- indicators -------------------------------------------------------

    async search_indicators({ query, limit = 20 }) {
      const all = studyCatalog();
      const q = String(query || '').trim().toLowerCase();
      const matches = q
        ? all.filter((s) => (s.name || '').toLowerCase().includes(q) || (s.short || '').toLowerCase().includes(q))
        : all;
      return { total: matches.length, results: matches.slice(0, Number(limit) || 20) };
    },

    async list_indicators() {
      return { indicators: chart().getAllStudies().map(studySummary) };
    },

    async add_indicator({ name, inputs = {}, overlay = false }) {
      const c = chart();
      const resolved = findStudyName(name);
      const id = await c.createStudy(resolved, !!overlay, false, inputs || {});
      if (!id) throw new Error(`createStudy returned no id for "${resolved}".`);
      try { await c.waitForStudyCreated(id); } catch (_) { /* best effort */ }
      return { id, name: resolved, indicators: c.getAllStudies().map((s) => ({ id: s.id, name: s.name })) };
    },

    async update_indicator({ id, inputs }) {
      const s = chart().getStudyById(id);
      if (!s) throw new Error(`No indicator with id ${id}.`);
      s.setInputValues(
        Object.entries(inputs || {}).map(([k, v]) => ({ id: k, value: v }))
      );
      return { id, inputs: s.getInputValues() };
    },

    async remove_indicator({ id }) {
      chart().removeEntity(id);
      return { removed: id, indicators: chart().getAllStudies().map((s) => ({ id: s.id, name: s.name })) };
    },

    // ---- drawings ---------------------------------------------------------

    async list_drawings() {
      return { drawings: chart().getAllShapes() };
    },

    async create_horizontal_line({ price, text }) {
      const c = chart();
      const t = bars().last().value[0];
      const id = await c.createShape(
        { time: t, price: Number(price) },
        { shape: 'horizontal_line', text: text || undefined }
      );
      return { id, shape: 'horizontal_line', price: Number(price) };
    },

    async create_vertical_line({ time }) {
      const t = snapToBar(Number(time));
      const id = await chart().createShape({ time: t }, { shape: 'vertical_line' });
      return { id, shape: 'vertical_line', time: t };
    },

    async create_trend_line({ from, to, text }) {
      if (!from || !to) throw new Error('from and to are required, each {time, price}');
      const id = await chart().createMultipointShape(
        [
          { time: snapToBar(Number(from.time)), price: Number(from.price) },
          { time: snapToBar(Number(to.time)), price: Number(to.price) },
        ],
        { shape: 'trend_line', text: text || undefined }
      );
      return { id, shape: 'trend_line' };
    },

    async create_text({ time, price, text }) {
      if (!text) throw new Error('text is required');
      const id = await chart().createShape(
        { time: snapToBar(Number(time)), price: Number(price) },
        { shape: 'text', text: String(text) }
      );
      return { id, shape: 'text' };
    },

    async remove_drawing({ id }) {
      chart().removeEntity(id);
      return { removed: id, drawings: chart().getAllShapes() };
    },

    // ---- pine -------------------------------------------------------------

    async open_pine_editor({ newScript = true } = {}) {
      const p = api().pineEditorTestApi();
      await p.openEditor();
      if (newScript) await p.openNewScript();
      return { open: true, newScript: !!newScript };
    },

    async set_pine_code({ code }) {
      if (!code) throw new Error('code is required');
      await api().pineEditorTestApi().setEditorText(String(code));
      return { ok: true, length: String(code).length };
    },

    async add_pine_to_chart() {
      const c = chart();
      const before = new Set(c.getAllStudies().map((s) => s.id));
      await api().pineEditorTestApi().addScriptOnChart();

      // Compilation + attach is async; poll for the new study to appear.
      let added = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        added = c.getAllStudies().find((s) => !before.has(s.id));
        if (added) break;
      }
      if (!added) {
        return { ok: false, error: 'Script did not attach — it most likely failed to compile. Check the Pine editor console.' };
      }

      const result = { ok: true, id: added.id, name: added.name };
      try {
        const s = c.getStudyById(added.id);
        result.hasError = !!(s.hasError && s.hasError());
        if (s.status) result.status = s.status();
      } catch (_) { /* ignore */ }
      return result;
    },

    // ---- strategy ---------------------------------------------------------

    async get_strategy_report({ id } = {}) {
      const c = chart();
      let studyId = id;
      if (!studyId) {
        // Pick the study that actually carries a strategy report.
        for (const e of c.getAllStudies()) {
          try {
            const st = c.getStudyById(e.id).study();
            if (st && typeof st.reportData === 'function' && st.reportData()) { studyId = e.id; break; }
          } catch (_) { /* not a strategy */ }
        }
      }
      if (!studyId) throw new Error('No strategy on the chart. Add a Pine strategy first.');

      const study = c.getStudyById(studyId).study();
      let data = null;
      for (let i = 0; i < 15; i++) {
        data = study.reportData && study.reportData();
        if (data && data.performance) break;
        await new Promise((r) => setTimeout(r, 700));
      }
      if (!data || !data.performance) throw new Error('Strategy report is not populated yet.');

      const p = data.performance;
      return {
        id: studyId,
        currency: data.currency,
        dateRange: data.settings && data.settings.dateRange,
        summary: {
          netProfit: p.all && p.all.netProfit,
          netProfitPercent: p.all && p.all.netProfitPercent,
          grossProfit: p.all && p.all.grossProfit,
          grossLoss: p.all && p.all.grossLoss,
          profitFactor: p.all && p.all.profitFactor,
          totalTrades: p.all && p.all.totalTrades,
          winningTrades: p.all && p.all.numberOfWiningTrades,
          losingTrades: p.all && p.all.numberOfLosingTrades,
          percentProfitable: p.all && p.all.percentProfitable,
          avgTrade: p.all && p.all.avgTrade,
          largestWin: p.all && p.all.largestWinTrade,
          largestLoss: p.all && p.all.largestLosTrade,
          maxDrawdown: p.maxStrategyDrawDown,
          maxDrawdownPercent: p.maxStrategyDrawDownPercent,
          maxRunUp: p.maxStrategyRunUp,
          sharpeRatio: p.sharpeRatio,
          sortinoRatio: p.sortinoRatio,
          buyHoldReturnPercent: p.buyHoldReturnPercent,
          openPL: p.openPL,
        },
        tradeCount: (data.trades || []).length,
      };
    },
  };

  // ---------------------------------------------------------------- bridge

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.origin !== ORIGIN) return;
    const msg = event.data;
    if (!msg || msg.source !== REQ || typeof msg.id !== 'string') return;

    const reply = (payload) =>
      window.postMessage({ source: RES, id: msg.id, ...payload }, ORIGIN);

    const handler = HANDLERS[msg.method];
    if (!handler) {
      reply({ ok: false, error: `Unknown method "${msg.method}".` });
      return;
    }

    try {
      log('→', msg.method, msg.params);
      const t0 = performance.now();
      const result = await handler(msg.params || {});
      log('←', msg.method, Math.round(performance.now() - t0) + 'ms');
      reply({ ok: true, result });
    } catch (err) {
      log('✗', msg.method, err);
      reply({ ok: false, error: (err && err.message) || String(err) });
    }
  });

  // Expose for manual poking from DevTools (not used by the extension).
  window.__tvAgent = { call: (m, p) => HANDLERS[m](p || {}), methods: Object.keys(HANDLERS) };

  log('driver ready,', Object.keys(HANDLERS).length, 'methods');
})();
