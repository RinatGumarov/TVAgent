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

  // ---------------------------------------------------------------- widget bar
  //
  // Every line that reaches into TradingView's widget bar lives in this one
  // block. `wb` owns all of the state a mount creates and teardown() is the
  // single place that hands every piece of it back.

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
    // The layout we are subscribed to, not a flag: refreshFromTVSettings()
    // swaps the whole layout object (widget-bar.ts:379-407).
    watching: null,
    unloadArmed: false,
    // Must start undefined, not false — the first sync may legitimately be false.
    lastActive: undefined,
    // The in-flight mount promise, if any. wbMount now awaits
    // waitForWidgetBar() before touching any of the fields above, so — unlike
    // every other handler here — it is no longer atomic within one message
    // dispatch: a second widgetbar_mount message can arrive while the first
    // is still parked in the poll. Without this, both calls would pass the
    // "already mounted" fast path (still unset for both), both would call
    // createPage(), and the second page would silently orphan the first's
    // page, button and observer.
    mounting: null,
  };

  function layout() {
    const bar = window.widgetbar;
    if (!bar || !bar.layout) {
      throw new Error('TradingView widget bar is not on this page (anonymous session?).');
    }
    return bar.layout;
  }

  /**
   * True once everything a mount needs actually exists: `window.widgetbar`,
   * its `.layout`, and the right-toolbar DOM node `injectButton` clones from.
   * widget-bar.ts's constructor sets `this.layout` synchronously, so the
   * first two always arrive together — but the toolbar itself is a separate
   * React render and can still lag behind by a tick, so it gets its own check
   * rather than being assumed from the other two.
   */
  function widgetBarPresent() {
    const bar = window.widgetbar;
    return !!(bar && bar.layout && document.querySelector('[data-name="right-toolbar"]'));
  }

  // widgetbar-creator.ts only calls createWidgetBar() once window.is_authenticated
  // is true (either at page load or on a live login), so that flag is what
  // separates "the bar is on its way" from "there will never be one" — measured
  // at 1084ms, well ahead of the bar itself (2735-3082ms). 40 attempts at
  // 200ms apart is an 8s budget: about 2.6x the slowest of three measured
  // reloads, comfortably inside bridge.js's 45s call timeout, and fine-grained
  // enough (200ms) that the common case doesn't overshoot the real readiness
  // time by much.
  const WIDGETBAR_WAIT_ATTEMPTS = 40;
  const WIDGETBAR_POLL_INTERVAL_MS = 200;

  /**
   * Waits for the widget bar to be mountable, or rejects fast when it never
   * will be. Polls rather than hooking `window.loginStateChange`: that global
   * exists, but subscribing to a host object couples us to internals we do
   * not otherwise need.
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
   * Keeps our tab button and the content script in step with whatever the user
   * does to the widget bar, including opening one of TradingView's own tabs.
   *
   * Wrapped in try/catch: TradingView's WatchedValue.setValue already guards
   * each listener with try/catch + logError (packages/common/src/watched-value.ts),
   * so a throw here would not break the host's notification loop — but it would
   * still desync our button silently and spam their telemetry.
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
   * Subscriptions follow the layout, because the layout is replaceable:
   * onLoginStateChange -> refreshFromTVSettings() destroys it and installs a
   * fresh WidgetBarLayout (widget-bar.ts:362-407). That fires when the user
   * logs in without reloading — the ordinary way to get a widget bar at all,
   * since an anonymous chart has none. Latching on a boolean would leave
   * syncActive bound to the dead layout's watched values for good: the button
   * would stop tracking and the panel would stop hearing widgetbar-active,
   * silently. Everything else recovers on its own, because layout() re-reads
   * the global and destroy() detaches wb.el, which fails the mount fast path.
   */
  function watchActive() {
    const L = layout();
    if (wb.watching === L) return;
    if (wb.watching) {
      // WatchedValue.unsubscribe(cb) drops every matching listener
      // (packages/common/src/watched-value.ts).
      wb.watching.activePageIndex.unsubscribe(syncActive);
      wb.watching.isMinimized.unsubscribe(syncActive);
    }
    L.activePageIndex.subscribe(syncActive);
    L.isMinimized.subscribe(syncActive);
    wb.watching = L;
  }

  /**
   * The members of TradingView's WatchedValue that their tab button components
   * actually use (packages/common/src/watched-value.ts): value, setValue,
   * subscribe(cb, options), unsubscribe(cb).
   */
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
   * `layout.createPage()` leaves `page.tab` undefined — only demarshal() ever
   * builds one, through createTabButtonViewModel (page.ts:477-491, called from
   * page.ts:519). The host does not treat the field as optional:
   * page.onActiveStateChange does `ensure(this.tab)` (page.ts:93), so a page
   * without one throws the moment it is switched *to* or *away from* — and a
   * switch away happens on the user's next native tab click, which would leave
   * their whole widget bar wedged until reload. RightToolbar's constructor also
   * reads `tab.TabButtonComponent` for every page (right-toolbar.tsx:102-103),
   * so a remount would fail to construct at all.
   *
   * We build the view model ourselves rather than calling the host's
   * createTabButtonViewModel(): that one's onClick closes over
   * layout.onTabClick(this), which saves to the account's settings.
   *
   * `visible` is false on purpose. Once the page has a tab, RightToolbar
   * registers it in `_pages` and _renderPages() would draw a second button next
   * to the one we inject (right-toolbar.tsx:250-267) — and dropping `page.name`
   * does not help, because `undefined in obj` stringifies the key and finds the
   * entry the constructor stored under "undefined". bindTabButton's provider
   * returns null for a model that is not visible (bind-tab-button.tsx:53-57),
   * which suppresses the button at the only place that can. `onClick` holds
   * undefined and `isDisabled` true for the same reason a belt gets braces:
   * even if one were rendered it would come out inert and disabled
   * (tab-button.tsx:45-49) and could not reach onTabClick.
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
      // The three methods page.ts calls on `tab` (page.ts:93, 432, 438, 593, 599).
      onActiveStateChange: (state) => active.setValue(!!state),
      updateNotifications: (value) => count.setValue(Number(value) || 0),
      updateNotificationCounterAriaLabel: (value) => ariaLabel.setValue(String(value || '')),
    };
  }

  /** Everything the host needs true of our page before it joins the rotation. */
  function preparePage(page, title) {
    page.tab = inertTab(title);
    // `name` is a plain mutable field (page.ts:41) — nothing refuses the write.
    // It keeps RightToolbar from logging "Page does not provide required field
    // name" on every construction (right-toolbar.tsx:96-100) and gives React a
    // stable key. It costs a wrong layout.activeName, which widgetbar_activate
    // puts back.
    page.name = PAGE_NAME;
    return page;
  }

  /**
   * TradingView's own buttons carry per-build hashed classes, so the button is
   * cloned from a live one rather than described in CSS. Only the badge inside
   * is ours, which is also why no hash has to be derived for the active state.
   *
   * Which button gets cloned matters, and one selector settles both traps.
   * `aria-pressed` is written only by TabButton (tab-button.tsx:54), so asking
   * for it skips the CloseButton that takes first place in DOM order when
   * `widgetBar.adaptive && isFullscreen` (right-toolbar.tsx:179-181). Asking
   * for "false" skips a tab that is currently active: ToolWidgetButton puts the
   * active hash on the <button> itself (tool-widget-button.tsx:74-96), and on a
   * default chart the first tab in DOM order is the watchlist, which is
   * activeIndex 0 — cloning it would render our tab permanently on.
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
    // The toolbar keeps exactly one tab stop. Every TabButton renders with
    // tabIndex -1 until roving focus promotes it (use-roving-tabindex-element.ts),
    // and that promotion is a CustomEvent only that hook listens for
    // (roving-tabindex.ts), so nothing can ever demote a foreign button. A
    // tabindex of 0 here would not merely add a second stop: our button would
    // be the only hit in queryTabbableElements, and the toolbar's initialiser
    // only promotes one of its own when that list is empty (toolbar.tsx:33-41),
    // so the host's buttons would stay unreachable by Tab. Arrow keys still
    // reach us — queryFocusableElements matches a plain button.
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
   * React owns this subtree and we are a foreign child inside it, so any
   * re-render of the tab list can drop us. RightToolbar force-updates when a
   * tab's visibility, disabled or active state changes
   * (right-toolbar.tsx:226-239), and re-renders on fullscreen transitions,
   * which add and remove the CloseButton (right-toolbar.tsx:179-181).
   * syncActive() rides along because a re-render is a cheap hint that the bar's
   * state may have moved; it de-dupes itself.
   */
  function watchToolbar(toolbar, btn) {
    wb.observer = new window.MutationObserver(() => {
      if (!toolbar.contains(btn)) placeButton(toolbar, btn);
      syncActive();
    });
    wb.observer.observe(toolbar, { childList: true });
  }

  /**
   * The one way out. Everything mount created is undone in the reverse order it
   * was made: the observer first, so it cannot put the button back; then the
   * button; then the page, after handing the user their own tab.
   */
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
    // wb.watching is left alone: both subscriptions read wb.page on every call,
    // so they are correct with no page, and they are keyed to the layout rather
    // than to a mount — watchActive() re-points them if it is ever swapped.
    wb.lastActive = undefined;
    syncActive();
  }

  /**
   * Our page has to leave layout.pages before the document does, so that
   * nothing — a RightToolbar remount above all — meets it, and the user is left
   * on their own tab rather than behind ours.
   *
   * `pagehide` rather than `beforeunload`: a beforeunload listener disqualifies
   * the page from the back/forward cache in Firefox, and it does not fire on a
   * bfcache navigation or a tab discard anywhere. It is armed from mount rather
   * than at driver load, so chart pages that never open the panel pay nothing.
   *
   * What this cannot do is undo a settings write. Nothing calls
   * saveToTVSettings() at unload; if the widget bar was written during the
   * session it was written then — see widgetbar_activate for the field that
   * actually takes the damage and what is done about it.
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
   * Creates a real widget bar page and returns the id of its element.
   *
   * Just a reentrancy guard around wbMountBody(): the await inside means two
   * widgetbar_mount messages can now overlap (see wb.mounting), and sharing
   * one in-flight attempt is simpler and safer than trying to make the body
   * itself concurrency-safe.
   */
  function wbMount(opts) {
    if (wb.el && document.contains(wb.el)) return Promise.resolve({ ok: true, pageId: PAGE_ID });
    if (wb.mounting) return wb.mounting;
    wb.mounting = wbMountBody(opts).finally(() => { wb.mounting = null; });
    return wb.mounting;
  }

  async function wbMountBody({ label = 'AI', title = 'TVAgent' } = {}) {
    // A mount whose element is gone still owns a page in layout.pages, a button
    // in the toolbar and a live observer that would put that button back —
    // running the body again would leave the user with two identical tabs.
    teardown();

    // The chart has this same asynchrony and bridge.js's probeWhenReady()
    // retries for it; nothing equivalent existed here, so the very first
    // mount call — which lands well before window.widgetbar exists on a
    // freshly authenticated page — used to fail permanently instead of
    // waiting.
    await waitForWidgetBar();

    const L = layout();
    // Pre-flight only: createPage() appends to the layout's own container
    // (layout.ts:391), not to whatever this query happens to find.
    if (!document.querySelector('.widgetbar-pagescontent')) {
      throw new Error('Widget bar page container not found.');
    }

    const page = L.createPage();
    wb.page = page;
    try {
      // First, before anything below can throw: a rollback runs removePage,
      // which switches pages when ours is the active one, and that would call
      // onActiveStateChange on a page with no tab.
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
      // createPage() has already mutated layout.pages and the DOM, and
      // injectButton fails on real conditions — the hide_right_toolbar_tabs
      // featureset renders no toolbar at all (right-toolbar-renderer.ts:11-24).
      // The caller falls back to its own overlay, so leave nothing behind.
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
    // Capture on page identity, not visibility: our page can be the active
    // one while the bar is minimized, and remembering ourselves as the
    // previous tab would lose the user's real one for good.
    if (index !== L.activeIndex) {
      wb.prevPage = L.pages[L.activeIndex] || null;
      wb.prevMinimized = !!L.isMinimized.value();
    }
    L.switchPage(index);
    // switchPage has just set layout.activeName to ours (layout.ts:301), and
    // that string is persisted by the next saveToTVSettings() — a native tab
    // click (layout.ts:364-366), a widget divider drag (page.ts:297-299) or a
    // drag of the bar's own edge (layout.ts:703-707), which is exactly what a
    // user does to resize our panel. On the next load demarshal finds no page
    // by that name and resets to index 0 (layout.ts:598-600), silently losing
    // the tab the user had open. Point it back at theirs: activeName is read
    // only by demarshal and marshal, never at runtime.
    L.activeName = (wb.prevPage && wb.prevPage.name) || '';
    L.setMinimizedState(false);
    return { ok: true };
  }

  function wbDeactivate() {
    const L = layout();
    // Only put things back if we are the one showing — the user may have
    // opened a native tab since, and restoring then would move them. The
    // index check alone is fooled when we are detached and nothing is
    // active (both -1), so detachment is excluded explicitly.
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
        let loadedBars = null;
        try {
          loadedBars = bars();
          report.series = !loadedBars.isEmpty();
        } catch (_) { report.series = false; }
        // The last close, for the panel's context row. Read separately from
        // series above and on its own try/catch, so a failure here (however
        // unlikely) cannot undo an already-correct series flag. Deliberately
        // left absent (not even null) rather than set from a partial read:
        // bars() throws its own "No bar data loaded yet" while the chart is
        // still loading, and that must not fail the whole probe.
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
    // Bodies live in the widget bar block above, so that all of it — including
    // the teardown they share — reads as one unit.

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
  window.__tvAgent = {
    call: (m, p) => HANDLERS[m](p || {}),
    methods: Object.keys(HANDLERS),
    // Test-only seam, kept past task 3: it does to a page exactly what mount
    // does — preparePage, then adopt — minus the DOM, so the state machine can
    // be driven without a toolbar to clone from. Anything that mount does to
    // the page itself has to happen here too, or the tests go green over a page
    // the host cannot activate.
    __adopt: (page, title) => {
      preparePage(page, title || 'TVAgent');
      wb.page = page;
      watchActive();
    },
  };

  log('driver ready,', Object.keys(HANDLERS).length, 'methods');
})();
