/**
 * TVAgent — where the panel lives.
 *
 * Two states. Native: a real TradingView widget bar page, so the chart shrinks
 * instead of being covered and TradingView owns the width and the resize
 * handle. Overlay: today's fixed right-hand panel, which is also the only
 * option for an anonymous session — TradingView builds no widget bar at all
 * unless window.is_authenticated.
 */
window.TVAgentMount = (() => {
  'use strict';

  const bridge = window.TVAgentBridge;

  let root = null;
  let mode = 'overlay';
  let activeListenerBound = false;
  let resizerWired = false;
  const activeHandlers = [];

  /**
   * @returns {Promise<{root: HTMLElement, mode: 'native'|'overlay'}>}
   */
  async function mount() {
    root = document.createElement('div');
    root.id = 'tva-root';

    const host = await nativeHost();
    if (host) attachNative(host);
    else attachOverlay();

    // The driver tears the widget bar page down on pagehide, including a
    // bfcache navigation — see onPageShow for the restore side of that.
    window.addEventListener('pageshow', onPageShow);

    return { root, mode };
  }

  /** The widget bar page element, or null if there is no widget bar to use. */
  async function nativeHost() {
    try {
      const res = await bridge.call('widgetbar_mount', { label: 'AI', title: 'TVAgent' });
      return document.getElementById(res.pageId);
    } catch (err) {
      console.info('[TVAgent] widget bar unavailable, falling back to the overlay:', err.message);
      return null;
    }
  }

  /** TradingView's page becomes root's parent; width, hiding and reflow are its job. */
  function attachNative(host) {
    mode = 'native';
    root.classList.remove('tva-overlay', 'tva-hidden');
    host.appendChild(root);
    root.classList.add('tva-native');
    bindActiveListener();
  }

  /** Today's fixed right-hand panel — also the only option pre-login. */
  function attachOverlay() {
    mode = 'overlay';
    root.classList.remove('tva-native');
    document.documentElement.appendChild(root);
    root.classList.add('tva-overlay', 'tva-hidden');
    wireResizer();
  }

  /**
   * Driver-pushed active/inactive events. Bound once regardless of how many
   * times attachNative runs, so a bfcache restore never leaves a second
   * listener firing every onActive handler twice.
   *
   * Gated on the current mode: the driver's teardown() deliberately leaves
   * wb.watching's subscriptions on activePageIndex/isMinimized alive — they
   * are keyed to the layout, not to a mount — so after a failed restore that
   * fell back to overlay, the next native tab click can still make the
   * driver emit widgetbar-active with wb.page === null. Without this check
   * that stale event would reach onActive handlers even though the panel is
   * no longer native, breaking this module's contract.
   */
  function bindActiveListener() {
    if (activeListenerBound) return;
    activeListenerBound = true;
    bridge.on('widgetbar-active', ({ active }) => {
      if (mode !== 'native') return;
      activeHandlers.forEach((fn) => fn(active));
    });
  }

  /**
   * bfcache restore. `root` is not rebuilt here — it is ours, and pagehide's
   * teardown() (driver.js) only removes the widget bar *page element* that
   * held it; root and everything inside it (chat DOM, listeners, state)
   * survive as an orphaned subtree with the same JS reference and just need a
   * new parent. The old #tva-widgetbar-page node is gone for good — teardown
   * calls layout.removePage(), which removes that element from the document —
   * so the host has to be looked up again with a fresh widgetbar_mount call
   * rather than reused.
   *
   * If the remount fails (say, the user logged out in another tab and the
   * widget bar no longer exists), fall back to the overlay rather than leave
   * the panel detached from the document — the same fallback first boot uses.
   *
   * `mode !== 'native'` is a one-way door: once a failed restore has fallen
   * back to overlay, this handler never tries native again for the life of
   * this page instance, even on a later restore. That is deliberate, not an
   * oversight. A bfcache restore only happens on a back/forward navigation of
   * this same frozen page, so whatever made the mount fail (most plausibly:
   * the session logged out) is a real state change, not a transient race —
   * driver.js's own JS state is frozen and resumed along with everything
   * else, so there is no "it just hadn't loaded yet" case to recover from by
   * trying again. Retrying on every subsequent restore would also mean the
   * panel could jump between overlay and native across navigations, which is
   * worse UX than settling once. Recovering into native again is still
   * possible the ordinary way: a full reload re-runs mount() from scratch.
   */
  async function onPageShow(event) {
    if (!event.persisted || mode !== 'native') return;
    const host = await nativeHost();
    if (host) attachNative(host);
    else attachOverlay();
  }

  /** Native pages are opened by their tab; the overlay is toggled in place. */
  async function toggle() {
    if (mode === 'native') {
      const { active } = await bridge.call('widgetbar_state');
      await bridge.call(active ? 'widgetbar_deactivate' : 'widgetbar_activate');
      return;
    }
    root.classList.toggle('tva-hidden');
  }

  /** Fires with true/false when the panel becomes visible or hidden. */
  function onActive(handler) {
    activeHandlers.push(handler);
  }

  /** Overlay only — the native page uses TradingView's own handle. */
  function wireResizer() {
    if (resizerWired) return;
    resizerWired = true;

    const handle = document.createElement('div');
    handle.className = 'tva-resizer';
    root.appendChild(handle);

    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const width = Math.min(Math.max(window.innerWidth - e.clientX, 300), window.innerWidth * 0.7);
      root.style.width = width + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({ panelWidth: parseInt(root.style.width, 10) });
    });

    chrome.storage.local.get('panelWidth').then((s) => {
      if (s.panelWidth) root.style.width = s.panelWidth + 'px';
    });
  }

  return { mount, toggle, onActive, mode: () => mode };
})();
