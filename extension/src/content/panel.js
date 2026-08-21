/**
 * TVAgent — panel shell.
 *
 * The chrome around the conversation: header, context row, empty state and
 * composer. The conversation is panel-chat.js and the settings screen is
 * panel-settings.js; this file wires them to the agent.
 */
(() => {
  'use strict';

  if (window.__tvAgentPanelLoaded) return;
  window.__tvAgentPanelLoaded = true;

  const SUGGESTIONS = [
    'What am I looking at?',
    'Add EMA 50 and EMA 200',
    'Mark the high and low of the visible range',
    'Build an EMA 50/200 crossover strategy and backtest it',
  ];

  const esc = window.TVAgentChat.esc;

  /**
   * Panel width, in px, below which the narrow layout takes over.
   * panel.css's narrow section uses the same threshold.
   */
  const NARROW_WIDTH = 320;

  let root, chat, settings, listEl, settingsEl, emptyEl, inputEl, sendBtn;
  let contextEl, statusEl, modelChipEl, ctxChipEl, ctxLabelEl, ctxPopEl;
  let agent = null;
  let capabilities = null;
  let busy = false;
  let narrow = false;

  // ---------------------------------------------------------------- markup

  function build(mountRoot) {
    root = mountRoot;
    // Append rather than assign: the overlay resizer is already a child, and
    // assigning innerHTML would drop it.
    root.insertAdjacentHTML('beforeend', `
      <header class="tva-header">
        <span class="tva-brand">TVAgent</span>
        <span class="tva-spacer"></span>
        <button class="tva-icon" id="tva-new" title="New chat" aria-label="New chat">&#10227;</button>
        <button class="tva-icon" id="tva-gear" title="Settings" aria-label="Settings">&#9881;</button>
        <button class="tva-icon" id="tva-close" title="Close" aria-label="Close">&#10005;</button>
      </header>

      <div class="tva-context">
        <span class="tva-context-where" id="tva-where">—</span>
        <span class="tva-spacer"></span>
        <span class="tva-status" id="tva-status"><i class="tva-dot"></i><span>connecting…</span></span>
      </div>

      <div class="tva-body">
        <div class="tva-empty" id="tva-empty">
          <h2>What should I do on this chart?</h2>
          <p>I read the chart and change it directly — indicators, levels, Pine.</p>
          <div class="tva-suggestions" id="tva-suggestions"></div>
        </div>
        <div class="tva-list" id="tva-list"></div>
        <div class="tva-settings tva-hidden" id="tva-settings"></div>
      </div>

      <footer class="tva-composer">
        <div class="tva-field">
          <textarea id="tva-input" rows="1" placeholder="Ask, or tell me what to change…"></textarea>
          <div class="tva-field-row">
            <button class="tva-send" id="tva-send" disabled aria-label="Send">&#8593;</button>
          </div>
        </div>
        <div class="tva-composer-chips">
          <div class="tva-ctx-pop tva-hidden" id="tva-ctx-pop" role="dialog" aria-label="What the agent is bound to">
            <div class="tva-ctx-row"><span>Symbol</span><b id="tva-ctx-symbol">—</b></div>
            <div class="tva-ctx-row"><span>Timeframe</span><b id="tva-ctx-resolution">—</b></div>
            <div class="tva-ctx-row"><span>Last price</span><b id="tva-ctx-price">—</b></div>
            <p class="tva-ctx-note">Symbol and timeframe go with every message. Prices and bars the agent reads itself, with its own tools.</p>
          </div>
          <button class="tva-chip" id="tva-model-chip" type="button">Claude Opus</button>
          <button class="tva-chip tva-chip-context tva-hidden" id="tva-in-context" type="button" aria-expanded="false"><span id="tva-in-context-label"></span><i>&#9662;</i></button>
        </div>
        <p class="tva-composer-hint">Enter to send · Shift+Enter for a new line</p>
      </footer>
    `);

    listEl = root.querySelector('#tva-list');
    settingsEl = root.querySelector('#tva-settings');
    emptyEl = root.querySelector('#tva-empty');
    inputEl = root.querySelector('#tva-input');
    sendBtn = root.querySelector('#tva-send');
    contextEl = root.querySelector('#tva-where');
    statusEl = root.querySelector('#tva-status');
    modelChipEl = root.querySelector('#tva-model-chip');
    ctxChipEl = root.querySelector('#tva-in-context');
    ctxLabelEl = root.querySelector('#tva-in-context-label');
    ctxPopEl = root.querySelector('#tva-ctx-pop');

    chat = window.TVAgentChat.create(listEl);

    const sugEl = root.querySelector('#tva-suggestions');
    SUGGESTIONS.forEach((text) => {
      const card = document.createElement('button');
      card.className = 'tva-suggestion';
      card.type = 'button';
      card.innerHTML = `<span>${esc(text)}</span><i>&#8593;</i>`;
      // A suggestion sends straight away — filling the box just adds a step.
      card.addEventListener('click', () => submit(text));
      sugEl.appendChild(card);
    });

    root.querySelector('#tva-new').addEventListener('click', () => {
      // reset() ends a run in flight first; clearing the list before that
      // would let it write into the fresh chat.
      agent?.reset();
      if (busy) endRun('ok');
      chat.clear();
      showScreen('chat');
      setEmpty(true);
    });
    root.querySelector('#tva-gear').addEventListener('click', () => toggleSettings());
    root.querySelector('#tva-close').addEventListener('click', () => window.TVAgentMount.toggle());
    modelChipEl.addEventListener('click', () => toggleSettings(true));
    ctxChipEl.addEventListener('click', toggleContext);
    watchWidth();

    sendBtn.addEventListener('click', () => (busy ? agent?.cancel() : submit(inputEl.value)));
    inputEl.addEventListener('input', () => {
      sendBtn.disabled = busy ? false : !inputEl.value.trim();
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit(inputEl.value);
      }
    });
  }

  // ---------------------------------------------------------------- screens

  function showScreen(which) {
    closeContext();
    settingsEl.classList.toggle('tva-hidden', which !== 'settings');
    listEl.classList.toggle('tva-hidden', which === 'settings');
    emptyEl.classList.toggle('tva-hidden', which === 'settings' || !isEmpty());
    root.querySelector('.tva-composer').classList.toggle('tva-hidden', which === 'settings');
  }

  function toggleSettings(force) {
    const opening = force === true || settingsEl.classList.contains('tva-hidden');
    showScreen(opening ? 'settings' : 'chat');
    if (opening) settings.refresh();
  }

  const isEmpty = () => listEl.children.length === 0;
  const setEmpty = (empty) => emptyEl.classList.toggle('tva-hidden', !empty);

  function setStatus(kind, text) {
    statusEl.className = 'tva-status ' + kind;
    statusEl.querySelector('span').textContent = text;
    // Narrow hides the word and leaves only the dot — the title is where the
    // word goes, so hovering still answers "connected to what, exactly?".
    statusEl.title = text;
  }

  /**
   * Locale-aware grouping; two decimals, widening to six under $1 so a low
   * price does not round to 0.00.
   */
  function formatPrice(price) {
    if (price == null || !isFinite(price)) return '';
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: Math.abs(price) < 1 ? 6 : 2,
    }).format(price);
  }

  /**
   * TradingView's resolution strings written the way its interval button
   * writes them: 1m, 90m, 4h, 1D, 1W, 1M. Anything unrecognised passes
   * through untouched.
   */
  function formatResolution(res) {
    if (res == null || res === '') return '';
    const s = String(res).toUpperCase();

    const seconds = /^(\d+)S$/.exec(s);
    if (seconds) return `${seconds[1]}s`;

    const minutes = /^(\d+)$/.exec(s);
    if (minutes) {
      const total = Number(minutes[1]);
      return total >= 60 && total % 60 === 0 ? `${total / 60}h` : `${total}m`;
    }

    // "D" and "1D" are the same daily chart; write both the long way.
    const calendar = /^(\d*)([DWM])$/.exec(s);
    if (calendar) return `${calendar[1] || 1}${calendar[2]}`;

    return String(res);
  }

  /** "BINGX:BTCUSDT.P · 4h · 64,446.70", or "no chart" when nothing is bound. */
  function contextLine() {
    const caps = capabilities || {};
    return caps.symbol
      ? [caps.symbol, formatResolution(caps.resolution), formatPrice(caps.price)].filter(Boolean).join(' · ')
      : 'no chart';
  }

  function setContext() {
    const caps = capabilities || {};
    const where = contextLine();
    contextEl.textContent = where;
    // The row is one line and truncates; the title is the rest of it.
    contextEl.title = where;

    ctxChipEl.classList.toggle('tva-hidden', !caps.symbol);
    root.querySelector('#tva-ctx-symbol').textContent = caps.symbol || '—';
    root.querySelector('#tva-ctx-resolution').textContent = formatResolution(caps.resolution) || '—';
    root.querySelector('#tva-ctx-price').textContent = formatPrice(caps.price) || '—';
    setContextChip();
  }

  /**
   * Wide spells the whole binding out; narrow has room for the ticker only,
   * and the rest moves into the popover.
   */
  function setContextChip() {
    const caps = capabilities || {};
    if (!caps.symbol) return;
    // Symbol and timeframe only: the price does not travel with the message.
    const bound = [caps.symbol, formatResolution(caps.resolution)].filter(Boolean).join(' · ');
    ctxLabelEl.textContent = narrow ? caps.symbol.split(':').pop() : `${bound} in context`;
    ctxChipEl.title = contextLine();
  }

  // ------------------------------------------------------- context popover

  const contextOpen = () => !ctxPopEl.classList.contains('tva-hidden');

  /** Wide already shows the whole line — there is nothing left to reveal. */
  function toggleContext() {
    if (!narrow) return;
    if (contextOpen()) closeContext();
    else openContext();
  }

  function openContext() {
    ctxPopEl.classList.remove('tva-hidden');
    ctxChipEl.setAttribute('aria-expanded', 'true');
    // Capture, not bubble: a bubbling listener would catch the click that
    // opened the popover.
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onDocumentKey, true);
  }

  function closeContext() {
    if (!contextOpen()) return;
    ctxPopEl.classList.add('tva-hidden');
    ctxChipEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onDocumentKey, true);
  }

  function onDocumentClick(e) {
    if (ctxPopEl.contains(e.target) || ctxChipEl.contains(e.target)) return;
    closeContext();
  }

  function onDocumentKey(e) {
    if (e.key === 'Escape') closeContext();
  }

  // ----------------------------------------------------------------- width

  /**
   * The panel's own width picks the layout, not the viewport's; neither the
   * widget bar nor the overlay is something a media query can see.
   */
  function watchWidth() {
    new window.ResizeObserver((entries) => {
      const width = entries[entries.length - 1].contentRect.width;
      // A hidden panel measures 0. That is "not rendered", not "narrow".
      if (width > 0) setNarrow(width <= NARROW_WIDTH);
    }).observe(root);
  }

  function setNarrow(next) {
    if (next === narrow) return;
    narrow = next;
    root.classList.toggle('tva-narrow', narrow);
    // Widening puts the whole line back on the chip; a popover repeating it
    // would just sit on top of the answer.
    if (!narrow) closeContext();
    setContextChip();
  }

  /** Same shape as the "no chart" branch below, reused by the boot-failure paths. */
  function showError(statusText, message) {
    setStatus('err', statusText);
    setEmpty(false);
    chat.error(message);
  }

  // ---------------------------------------------------------------- chat

  function submit(text) {
    const trimmed = String(text).trim();
    if (!trimmed || !agent || busy) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    // showScreen derives the empty state from the list, so the message has to
    // land first.
    chat.user(trimmed);
    showScreen('chat');
    startRun();
    agent.send(trimmed);
  }

  function startRun() {
    busy = true;
    chat.startRun();
    sendBtn.classList.add('stop');
    sendBtn.innerHTML = '&#9632;';
    sendBtn.disabled = false;
    sendBtn.setAttribute('aria-label', 'Stop');
    setStatus('warn', 'working…');
  }

  function endRun(status) {
    busy = false;
    chat.endRun();
    sendBtn.classList.remove('stop');
    sendBtn.innerHTML = '&#8593;';
    sendBtn.disabled = !inputEl.value.trim();
    sendBtn.setAttribute('aria-label', 'Send');
    setStatus(status === 'err' ? 'err' : 'ok', status === 'err' ? 'error' : 'connected');
  }

  function handlers() {
    return {
      autoApprove: () => settings.autoApprove(),
      onBlockStart: chat.onBlockStart,
      onThinking: chat.onThinking,
      onText: chat.onText,
      onToolStart: chat.onToolStart,
      onToolResult: chat.onToolResult,
      onConfirm: chat.onConfirm,
      onDone: () => endRun('ok'),
      onError(err) {
        chat.error(err?.message || String(err));
        endRun('err');
      },
    };
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    let mountRoot, mode;
    try {
      ({ root: mountRoot, mode } = await window.TVAgentMount.mount());
    } catch (err) {
      // build() has not run, so there is no panel to write into: a standalone
      // banner instead.
      showFatalMountError(err);
      return;
    }

    build(mountRoot);

    try {
      settings = window.TVAgentSettings.create(settingsEl, {
        onChange: ({ provider, model }) => {
          modelChipEl.textContent =
            provider === 'anthropic'
              ? window.TVAgentModels.chip(model)
              : model || 'Pick a model';
        },
      });

      // The panel is only useful once it has been told what to call.
      const configured = await settings.ready;
      if (!configured) toggleSettings(true);
    } catch (err) {
      showError('error', 'TVAgent failed to start: ' + (err?.message || String(err)));
      return;
    }

    if (mode === 'native') {
      window.TVAgentMount.onActive((active) => {
        if (active) inputEl.focus();
      });
    }

    setStatus('warn', 'connecting…');
    try {
      capabilities = await window.TVAgentBridge.probeWhenReady();
    } catch (err) {
      showError('error', 'TVAgent failed to start: ' + (err?.message || String(err)));
      return;
    }
    setContext();

    if (!capabilities.tradingViewApi || !capabilities.chart) {
      showError(
        'no chart',
        'Could not reach the TradingView API on this page. Open a chart at ' +
          'tradingview.com/chart/ and reload.'
      );
      return;
    }

    setStatus(capabilities.loggedIn ? 'ok' : 'warn', capabilities.loggedIn ? 'connected' : 'logged out');
    (capabilities.warnings || []).forEach((w) => {
      setEmpty(false);
      chat.notice('⚠ ' + w);
    });

    agent = new window.TVAgentRuntime.Agent({ capabilities, handlers: handlers() });
    watchChart();
  }

  /**
   * The driver pushes a fresh capability report on every symbol and
   * timeframe change. Merged in place, because the agent holds this exact
   * object and reads it on every turn.
   */
  function watchChart() {
    window.TVAgentBridge.on('chart-changed', (report) => {
      if (!report || !capabilities) return;
      // price is absent, not null, until the new symbol's bars load; clear it
      // so the old one does not linger.
      delete capabilities.price;
      Object.assign(capabilities, report);
      setContext();
      if (!busy) {
        setStatus(
          capabilities.loggedIn ? 'ok' : 'warn',
          capabilities.loggedIn ? 'connected' : 'logged out'
        );
      }
    });
  }

  /** Shown when mount() itself fails and there is no #tva-root to write into. */
  function showFatalMountError(err) {
    const el = document.createElement('div');
    el.id = 'tva-boot-error';
    el.textContent = 'TVAgent failed to start: ' + (err?.message || String(err));
    el.style.cssText =
      'position:fixed;bottom:16px;right:16px;max-width:320px;padding:10px 14px;' +
      'background:#20242b;color:#ff6b6b;border:1px solid #ff6b6b;border-radius:8px;' +
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;z-index:2147483647;';
    document.documentElement.appendChild(el);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle-panel') window.TVAgentMount.toggle();
  });

  // Anything the catches above missed still gets a visible error.
  boot().catch((err) => {
    console.error('[TVAgent] boot failed:', err);
    if (chat) showError('error', 'TVAgent failed to start: ' + (err?.message || String(err)));
    else showFatalMountError(err);
  });
})();
