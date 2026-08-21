/**
 * TVAgent — panel shell.
 *
 * Builds the chrome around the conversation: header, the context row that says
 * what the agent is bound to, the empty state, and the composer. The
 * conversation itself is panel-chat.js and the settings screen is
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
   * Panel width, in px, below which the narrow layout takes over. Read here
   * and in panel.css's narrow section — they describe the same switch, so they
   * move together.
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
      // reset() ends a run in flight first (see Agent.reset), which comes back
      // here through onDone and puts the composer out of its Stop state. Doing
      // it in this order matters: clearing the list first would leave the
      // cancelled run writing its last trace rows into the fresh chat.
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
   * Locale-aware, not TradingView-exact: the grouping character follows the
   * browser's active locale (a comma in en-US, a space in many European
   * locales) rather than hand-rolling TradingView's own separator. Two
   * decimals covers ordinary equities/FX/majors; anything trading under $1 —
   * a lot of altcoins — widens up to 6 so the price does not round to 0.00.
   */
  function formatPrice(price) {
    if (price == null || !isFinite(price)) return '';
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: Math.abs(price) < 1 ? 6 : 2,
    }).format(price);
  }

  /**
   * TradingView's resolution strings are an API detail — "240" is four hours,
   * but only if you already know that. The panel writes what the interval
   * button writes: 1m, 90m, 4h, 1D, 1W, 1M. Anything this does not recognise
   * (range bars, ticks, whatever TradingView adds next) is passed through
   * untouched rather than guessed at.
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
   * Wide spells the whole binding out next to the model. Narrow has room for
   * the ticker and nothing else, so the exchange prefix, the timeframe and the
   * price move into the popover the chip opens.
   */
  function setContextChip() {
    const caps = capabilities || {};
    if (!caps.symbol) return;
    // Symbol and timeframe only: that is what actually travels with every
    // message. The price is one row up and in the popover, and dropping it
    // here is also what keeps the chip row to a single line at 400px.
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
    // Capture, not bubble: a bubbling listener registered from inside the
    // chip's own click handler would still catch that same click on its way up
    // to the document and close the popover in the gesture that opened it.
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
   * The panel's own width picks the layout, not the viewport's — in the widget
   * bar TradingView sets it, in the overlay the resize handle does, and
   * neither of those is something a media query can see.
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
    // The message has to land before the screen is recomputed — showScreen
    // derives the empty state from the list's length, so appending after it
    // leaves the empty-state placeholder sitting next to the first message.
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
      // Nothing to build into yet — build() has not run, so none of
      // #tva-root's chrome exists. Not reachable today (panel-mount.js
      // already catches its own known failure modes and falls back to the
      // overlay internally), but boot() should not fail silently if it ever
      // is. A standalone banner, styled inline since panel.css only targets
      // #tva-root's own descendants and there is no #tva-root yet.
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
   * The capability report is what the system prompt names and what the tool
   * list is filtered by, and it used to be read once, at boot. After a symbol
   * change the prompt still announced the old ticker, and a symbol whose bars
   * had not loaded when the panel started kept get_series_data switched off
   * for the rest of the session. The driver pushes a fresh report on every
   * symbol and timeframe change; this merges it in place.
   *
   * In place, because the agent was handed this exact object and reads it on
   * every turn. Replacing it would leave the agent holding the boot-time copy
   * and would look, from here, like it had worked.
   */
  function watchChart() {
    window.TVAgentBridge.on('chart-changed', (report) => {
      if (!report || !capabilities) return;
      // `price` is absent from the report, not null, whenever the new symbol's
      // bars have not loaded yet (see probe()). A plain merge would leave the
      // previous symbol's price standing next to the new ticker, so the keys
      // the report owns but may not carry are cleared first.
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

  /** No #tva-root exists yet at this point — see the comment at the call site. */
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

  // Belt and suspenders: boot() catches its own four fallible points with a
  // specific message each, but a bare async call still swallows anything
  // those catches missed — the exact bug this was fixed for (panel.js#262
  // in the original report). If build() had already run there is a panel to
  // write into; if not, fall back to the same standalone banner mount()'s
  // own failure uses.
  boot().catch((err) => {
    console.error('[TVAgent] boot failed:', err);
    if (chat) showError('error', 'TVAgent failed to start: ' + (err?.message || String(err)));
    else showFatalMountError(err);
  });
})();
