/**
 * TVAgent — where the panel lives.
 *
 * Native: a real widget bar page, so TradingView owns the width and the chart
 * shrinks. Overlay: a fixed right-hand panel, and the only option for an
 * anonymous session, which has no widget bar.
 */

import type { Bridge } from '../shared/protocol.ts';

export type PanelMode = 'native' | 'overlay';

/** The handoff from the document_start bundle; see src/types/globals.d.ts. */
function requireBridge(): Bridge {
  const bridge = window.TVAgentBridge;
  if (!bridge) throw new Error('The TVAgent bridge did not start.');
  return bridge;
}

// mount() creates it, and everything else here runs after mount().
let root!: HTMLElement;
let currentMode: PanelMode = 'overlay';
let activeListenerBound = false;
let resizerWired = false;
const activeHandlers: Array<(active: boolean) => void> = [];

async function mount(): Promise<{ root: HTMLElement; mode: PanelMode }> {
  root = document.createElement('div');
  root.id = 'tva-root';

  const host = await nativeHost();
  if (host) attachNative(host);
  else attachOverlay();

  // The driver tears the widget bar page down on pagehide, including a
  // bfcache navigation — see onPageShow for the restore side of that.
  window.addEventListener('pageshow', onPageShow);

  return { root, mode: currentMode };
}

/** The widget bar page element, or null if there is no widget bar to use. */
async function nativeHost() {
  try {
    const res = await requireBridge().call<{ pageId: string }>('widgetbar_mount', {
      label: 'AI',
      title: 'TVAgent',
    });
    const el = document.getElementById(res.pageId);
    if (!el) {
      // The driver reports success only once its page element is in the
      // document; say so if that ever fails.
      console.info(
        '[TVAgent] widget bar mount reported success but its page element is not in the document, falling back to the overlay.',
      );
    }
    return el;
  } catch (err) {
    console.info(
      '[TVAgent] widget bar unavailable, falling back to the overlay:',
      (err as Error).message,
    );
    return null;
  }
}

/** TradingView's page becomes root's parent; width, hiding and reflow are its job. */
function attachNative(host: HTMLElement) {
  currentMode = 'native';
  root.classList.remove('tva-overlay', 'tva-hidden');
  host.appendChild(root);
  root.classList.add('tva-native');
  bindActiveListener();
}

function attachOverlay() {
  currentMode = 'overlay';
  root.classList.remove('tva-native');
  document.documentElement.appendChild(root);
  root.classList.add('tva-overlay', 'tva-hidden');
  wireResizer();
}

/**
 * Driver-pushed active/inactive events, bound once. Gated on the mode: the
 * driver's layout subscriptions outlive a mount, so a stale event can
 * arrive after a fallback to the overlay.
 */
function bindActiveListener() {
  if (activeListenerBound) return;
  activeListenerBound = true;
  requireBridge().on('widgetbar-active', ({ active }) => {
    if (currentMode !== 'native') return;
    activeHandlers.forEach((fn) => fn(active));
  });
}

/**
 * bfcache restore. The driver's pagehide teardown removed the widget bar
 * page but not `root`, which survives as a detached subtree and only needs
 * a new parent. A remount that fails falls back to the overlay and stays
 * there: a restore replays the same frozen page, so the failure is a real
 * state change rather than a race.
 */
async function onPageShow(event: PageTransitionEvent) {
  if (!event.persisted || currentMode !== 'native') return;
  const host = await nativeHost();
  if (host) attachNative(host);
  else attachOverlay();
}

/** Native pages are opened by their tab; the overlay is toggled in place. */
async function toggle() {
  if (currentMode === 'native') {
    const bridge = requireBridge();
    const { active } = await bridge.call<{ active: boolean }>('widgetbar_state');
    await bridge.call(active ? 'widgetbar_deactivate' : 'widgetbar_activate');
    return;
  }
  root.classList.toggle('tva-hidden');
}

/** Fires with true/false when the panel becomes visible or hidden. */
function onActive(handler: (active: boolean) => void) {
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

  chrome.storage.local.get('panelWidth').then((s: { panelWidth?: number }) => {
    if (s.panelWidth) root.style.width = s.panelWidth + 'px';
  });
}

export { mount, toggle, onActive };

export const mode = () => currentMode;
