/**
 * TVAgent — page-context driver.
 *
 * Runs in the MAIN world, where window.TradingViewApi is reachable, and answers
 * the content script over window.postMessage. Only the methods in HANDLERS can
 * be invoked.
 */
(() => {
  'use strict';

  const REQ = 'tva-req';
  const RES = 'tva-res';
  const EVT = 'tva-evt';
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
   * Snaps a timestamp to the nearest loaded bar; createShape throws on a
   * time that is not one. NaN is refused rather than snapped.
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

  // ---------------------------------------------------------------- widget bar
  //
  // Everything that reaches into the widget bar. `wb` owns the state a mount
  // creates and teardown() hands all of it back.

  const PAGE_ID = 'tva-widgetbar-page';
  const PAGE_NAME = 'tva_agent';

  /** Unsolicited push to the content script. Requests still use RES. */
  function emit(type, payload) {
    window.postMessage({ source: EVT, type, payload }, ORIGIN);
  }

  const wb = {
    page: null, // WidgetBarPage handed out by layout.createPage()
    el: null, // page.element()
    button: null, // our cloned tab button
    observer: null, // MutationObserver over the right toolbar
    prevPage: null, // the user's tab, to put back on deactivate
    prevMinimized: false,
    watching: null,
    unloadArmed: false,
    // Must start undefined, not false — the first sync may legitimately be false.
    lastActive: undefined,
  };

  function layout() {
    const bar = window.widgetbar;
    if (!bar || !bar.layout) {
      throw new Error('TradingView widget bar is not on this page (anonymous session?).');
    }
    return bar.layout;
  }

  /**
   * True once everything a mount needs exists: window.widgetbar, its layout,
   * and the right-toolbar node the button is cloned from.
   */
  function widgetBarPresent() {
    const bar = window.widgetbar;
    return !!(bar && bar.layout && document.querySelector('[data-name="right-toolbar"]'));
  }

  const WIDGETBAR_WAIT_ATTEMPTS = 40;
  const WIDGETBAR_POLL_INTERVAL_MS = 200;

  /**
   * Waits for the widget bar to be mountable, or rejects at once when there
   * will never be one.
   */
  async function waitForWidgetBar() {
    if (widgetBarPresent()) return;
    if (!window.is_authenticated) {
      throw new Error('TradingView widget bar is not on this page (anonymous session?).');
    }
    for (let i = 0; i < WIDGETBAR_WAIT_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, WIDGETBAR_POLL_INTERVAL_MS));
      if (widgetBarPresent()) return;
    }
    throw new Error(
      `Timed out waiting for the TradingView widget bar to appear (waited ${WIDGETBAR_WAIT_ATTEMPTS * WIDGETBAR_POLL_INTERVAL_MS}ms).`
    );
  }

  function ourIndex() {
    return wb.page ? layout().pages.indexOf(wb.page) : -1;
  }

  function isActive() {
    if (!wb.page) return false;
    const L = layout();
    const index = ourIndex();
    return index !== -1 && index === L.activeIndex && !L.isMinimized.value();
  }

  /**
   * Keeps the tab button and the content script in step with the widget bar,
   * whoever changed it.
   */
  function syncActive() {
    try {
      const active = isActive();
      if (active === wb.lastActive) return;
      wb.lastActive = active;
      if (wb.button) {
        wb.button.classList.toggle('tva-tab-on', active);
        wb.button.setAttribute('aria-pressed', String(active));
      }
      emit('widgetbar-active', { active });
    } catch (e) {
      log('syncActive failed', e);
    }
  }

  /**
   * Subscriptions follow the layout object: a login state change makes
   * TradingView destroy it and install a fresh one.
   */
  function watchActive() {
    const L = layout();
    if (wb.watching === L) return;
    if (wb.watching) {
      wb.watching.activePageIndex.unsubscribe(syncActive);
      wb.watching.isMinimized.unsubscribe(syncActive);
    }
    L.activePageIndex.subscribe(syncActive);
    L.isMinimized.subscribe(syncActive);
    wb.watching = L;
  }

  function watchedValue(initial) {
    let current = initial;
    const subs = [];
    return {
      value: () => current,
      setValue(next) {
        if (next === current) return;
        current = next;
        subs.slice().forEach((fn) => {
          try { fn(current); } catch (e) { log('watched value listener failed', e); }
        });
      },
      subscribe(fn, options) {
        subs.push(fn);
        if (options && options.callWithLast) fn(current);
      },
      unsubscribe(fn) {
        if (!fn) { subs.length = 0; return; }
        const i = subs.indexOf(fn);
        if (i !== -1) subs.splice(i, 1);
      },
    };
  }

  /**
   * layout.createPage() leaves page.tab undefined, but the host asserts on
   * it whenever a page is switched to or away from. This inert view model
   * keeps the host happy: `visible` is false so the toolbar draws no second
   * button, and `onClick` is empty so nothing can reach the host's tab-click
   * handler.
   */
  function inertTab(hint) {
    const active = watchedValue(false);
    const count = watchedValue(0);
    const ariaLabel = watchedValue('');
    return {
      name: PAGE_NAME,
      product: null,
      area: null,
      isNew: false,
      TabButtonComponent: undefined,
      isActive: active,
      isDisabled: watchedValue(true),
      notificationsCount: count,
      notificationCounterAriaLabel: ariaLabel,
      icon: watchedValue(''),
      hint: watchedValue(hint || 'TVAgent'),
      onClick: watchedValue(undefined),
      visible: watchedValue(false),
      onActiveStateChange: (state) => active.setValue(!!state),
      updateNotifications: (value) => count.setValue(Number(value) || 0),
      updateNotificationCounterAriaLabel: (value) => ariaLabel.setValue(String(value || '')),
    };
  }

  /** Everything the host needs true of our page before it joins the rotation. */
  function preparePage(page, title) {
    page.tab = inertTab(title);
    // A name keeps the toolbar from logging a missing-field warning and gives
    // React a stable key.
    page.name = PAGE_NAME;
    return page;
  }

  /**
   * TradingView's buttons carry per-build hashed classes, so ours is cloned
   * from a live one. `aria-pressed="false"` picks a tab button that is not
   * the active one: the close button has no aria-pressed, and the active
   * tab's hash would leave ours lit.
   */
  function injectButton(label, title) {
    const toolbar = document.querySelector('[data-name="right-toolbar"]');
    if (!toolbar) throw new Error('Right toolbar not found.');

    const model =
      toolbar.querySelector('button[data-name][aria-pressed="false"]:not(:disabled)') ||
      toolbar.querySelector('button[data-name]:not(:disabled)');
    if (!model) throw new Error('No widget bar button to clone.');

    const btn = model.cloneNode(false);
    btn.setAttribute('data-name', 'tva-agent');
    btn.setAttribute('aria-label', title);
    btn.setAttribute('data-tooltip', title);
    btn.setAttribute('aria-pressed', 'false');
    // The toolbar keeps one roving tab stop of its own; a foreign button
    // stays at -1.
    btn.setAttribute('tabindex', '-1');
    btn.classList.add('tva-tab');

    const badge = document.createElement('span');
    badge.className = 'tva-tab-badge';
    badge.textContent = label;
    btn.appendChild(badge);

    btn.addEventListener('click', () => {
      if (isActive()) wbDeactivate();
      else wbActivate();
    });

    placeButton(toolbar, btn);
    wb.button = btn;
    return { toolbar, btn };
  }

  /** The top group ends at the first child that is not a button (the filler). */
  function placeButton(toolbar, btn) {
    const anchor = Array.prototype.find.call(toolbar.children, (c) => c.tagName !== 'BUTTON');
    toolbar.insertBefore(btn, anchor || null);
  }

  /**
   * React owns the toolbar and can drop our button on any re-render; put it
   * back.
   */
  function watchToolbar(toolbar, btn) {
    wb.observer = new window.MutationObserver(() => {
      if (!toolbar.contains(btn)) placeButton(toolbar, btn);
      syncActive();
    });
    wb.observer.observe(toolbar, { childList: true });
  }

  /** Undoes everything mount created, in reverse order. */
  function teardown() {
    if (!wb.page && !wb.el && !wb.button && !wb.observer) return;

    if (wb.observer) {
      wb.observer.disconnect();
      wb.observer = null;
    }
    if (wb.button) {
      if (wb.button.remove) wb.button.remove();
      wb.button = null;
    }
    if (wb.page) {
      const page = wb.page;
      try {
        if (isActive()) wbDeactivate();
        layout().removePage(page);
      } catch (e) {
        log('teardown could not remove the page', e);
      }
      wb.page = null;
    }
    wb.el = null;
    wb.prevPage = null;
    wb.prevMinimized = false;
    wb.lastActive = undefined;
    syncActive();
  }

  /**
   * Removes our page before the document goes away. `pagehide` rather than
   * `beforeunload`: it fires on bfcache navigations and does not disqualify
   * the page from the cache.
   */
  function armUnloadTeardown() {
    if (wb.unloadArmed) return;
    wb.unloadArmed = true;
    window.addEventListener('pagehide', () => {
      try {
        teardown();
      } catch (e) {
        /* the document is going away anyway */
      }
    });
  }

  /**
   * Creates the widget bar page. A mount already in flight is shared rather
   * than repeated.
   */
  async function wbMount({ label = 'AI', title = 'TVAgent' } = {}) {
    if (wb.el && document.contains(wb.el)) return { ok: true, pageId: PAGE_ID };
    // Clear whatever a previous mount left behind before creating anything.
    teardown();

    await waitForWidgetBar();

    const L = layout();
    // Pre-flight only: createPage() appends to the layout's own container,
    // not to whatever this query happens to find.
    if (!document.querySelector('.widgetbar-pagescontent')) {
      throw new Error('Widget bar page container not found.');
    }

    const page = L.createPage();
    wb.page = page;
    try {
      // Before anything below can throw: a rollback switches pages, which
      // needs the tab.
      preparePage(page, title);

      const el = page.element();
      if (!el) throw new Error('createPage() produced no page element.');
      wb.el = el;
      el.id = PAGE_ID;

      const { toolbar, btn } = injectButton(label, title);
      watchToolbar(toolbar, btn);
      watchActive();
      armUnloadTeardown();
    } catch (e) {
      // createPage() has already touched layout.pages and the DOM; leave
      // nothing behind.
      teardown();
      throw e;
    }

    return { ok: true, pageId: PAGE_ID };
  }

  /**
   * Activation goes through switchPage, never onTabClick — the latter calls
   * saveToTVSettings() and would write our page into the account's saved
   * widget bar layout.
   */
  function wbActivate() {
    const L = layout();
    const index = ourIndex();
    if (index === -1) throw new Error('Widget bar page is not mounted.');
    // On page identity, not visibility: our page can be active while the bar
    // is minimized.
    if (index !== L.activeIndex) {
      wb.prevPage = L.pages[L.activeIndex] || null;
      wb.prevMinimized = !!L.isMinimized.value();
    }
    L.switchPage(index);
    // activeName is persisted with the next settings save and would reset the
    // user's tab on reload.
    L.activeName = (wb.prevPage && wb.prevPage.name) || '';
    L.setMinimizedState(false);
    return { ok: true };
  }

  function wbDeactivate() {
    const L = layout();
    // Only when we are the one showing; detachment (-1) is excluded
    // explicitly.
    const index = ourIndex();
    if (index === -1 || index !== L.activeIndex) return { ok: true };
    if (wb.prevPage) L.switchPage(wb.prevPage);
    if (wb.prevMinimized) L.setMinimizedState(true);
    return { ok: true };
  }

  function wbState() {
    return { active: isActive(), minimized: !!layout().isMinimized.value() };
  }

  // ---------------------------------------------------------------- handlers

  const HANDLERS = {
    /** Startup capability probe. */
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
        // While TradingView is still loading, both of these throw "Value is
        // null".
        report.symbol = c.symbol();
        report.resolution = c.resolution();
        report.studies = typeof c.createStudy === 'function' && typeof c.getAllStudies === 'function';
        report.drawings = typeof c.createShape === 'function';
        report.strategy = typeof c.getStudyById === 'function';
        let loadedBars = null;
        try {
          loadedBars = bars();
          report.series = !loadedBars.isEmpty();
        } catch (_) { report.series = false; }
        // The last close, for the context row; absent rather than null until
        // the bars have loaded.
        if (report.series) {
          try { report.price = loadedBars.last().value[4]; } catch (_) { /* leave price absent */ }
        }
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

    // ---- widgetbar --------------------------------------------------------

    widgetbar_mount: wbMount,
    widgetbar_activate: wbActivate,
    widgetbar_deactivate: wbDeactivate,
    widgetbar_state: wbState,

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

      // The range is computed here so the model reads it rather than sums it.
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

  // DevTools seam.
  window.__tvAgent = {
    call: (m, p) => HANDLERS[m](p || {}),
    methods: Object.keys(HANDLERS),
    // Adopts a page the way mount does, minus the DOM, so the state machine
    // can be driven without a toolbar.
    __adopt: (page, title) => {
      preparePage(page, title || 'TVAgent');
      wb.page = page;
      watchActive();
    },
  };

  log('driver ready,', Object.keys(HANDLERS).length, 'methods');
})();
