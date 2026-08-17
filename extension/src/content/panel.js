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

  let root, chat, settings, listEl, settingsEl, emptyEl, inputEl, sendBtn;
  let contextEl, statusEl, modelChipEl;
  let agent = null;
  let capabilities = null;
  let busy = false;

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
            <button class="tva-chip" id="tva-model-chip" type="button">Claude Opus</button>
            <span class="tva-chip-hint" id="tva-in-context"></span>
            <span class="tva-spacer"></span>
            <button class="tva-send" id="tva-send" disabled aria-label="Send">&#8593;</button>
          </div>
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
      agent?.reset();
      chat.clear();
      showScreen('chat');
      setEmpty(true);
    });
    root.querySelector('#tva-gear').addEventListener('click', () => toggleSettings());
    root.querySelector('#tva-close').addEventListener('click', () => window.TVAgentMount.toggle());
    modelChipEl.addEventListener('click', () => toggleSettings(true));

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
  }

  function setContext() {
    const caps = capabilities || {};
    const where = caps.symbol
      ? [caps.symbol, caps.resolution].filter(Boolean).join(' · ')
      : 'no chart';
    contextEl.textContent = where;
    root.querySelector('#tva-in-context').textContent = caps.symbol ? `${where} in context` : '';
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
    const { root: mountRoot, mode } = await window.TVAgentMount.mount();
    build(mountRoot);

    settings = window.TVAgentSettings.create(settingsEl, {
      onChange: ({ provider, model }) => {
        modelChipEl.textContent = provider === 'anthropic' ? label(model) : model || 'Pick a model';
      },
    });

    // The panel is only useful once it has been told what to call.
    const configured = await settings.ready;
    if (!configured) toggleSettings(true);

    if (mode === 'native') {
      window.TVAgentMount.onActive((active) => {
        if (active) inputEl.focus();
      });
    }

    setStatus('warn', 'connecting…');
    capabilities = await window.TVAgentBridge.probeWhenReady();
    setContext();

    if (!capabilities.tradingViewApi || !capabilities.chart) {
      setStatus('err', 'no chart');
      setEmpty(false);
      chat.error(
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
  }

  const label = (model) =>
    ({
      'claude-opus-5': 'Claude Opus',
      'claude-sonnet-5': 'Claude Sonnet',
      'claude-haiku-4-5': 'Claude Haiku',
    }[model] || model);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle-panel') window.TVAgentMount.toggle();
  });

  boot();
})();
