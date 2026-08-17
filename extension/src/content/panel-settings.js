/**
 * TVAgent — settings screen.
 *
 * A screen rather than a drawer: the drawer pushed the conversation down every
 * time it opened. Provider, model and effort are segmented controls, so the
 * whole configuration is visible without opening anything.
 */
window.TVAgentSettings = (() => {
  'use strict';

  const KEYS = [
    'apiKey', 'model', 'effort', 'autoApprove',
    'provider', 'baseUrl', 'openaiApiKey', 'openaiModel',
  ];

  const MODELS = [
    { value: 'claude-opus-5', label: 'Opus 5' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ];

  const EFFORTS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Xhigh' },
  ];

  const PROVIDERS = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI-compatible' },
  ];

  /**
   * Storage used to keep one shared key/model slot for both providers, so
   * switching provider overwrote the other one's values. Move the shared pair
   * into the slot that owns it, once.
   */
  function migrate(s) {
    const split = s.openaiApiKey !== undefined || s.openaiModel !== undefined;
    if (s.provider !== 'openai' || split) return s;
    const shared = s.apiKey || '';
    const anthropicKey = shared.startsWith('sk-ant-');
    const moved = {
      openaiApiKey: anthropicKey ? '' : shared,
      openaiModel: s.model || '',
      apiKey: anthropicKey ? shared : '',
      model: '',
    };
    chrome.storage.local.set(moved);
    return { ...s, ...moved };
  }

  function segmented(name, options) {
    return (
      `<div class="tva-seg" data-seg="${name}">` +
      options
        .map((o) => `<button type="button" data-value="${o.value}">${o.label}</button>`)
        .join('') +
      '</div>'
    );
  }

  function create(hostEl, { onChange }) {
    hostEl.innerHTML = `
      <div class="tva-set-group">
        <label class="tva-set-label">Provider</label>
        ${segmented('provider', PROVIDERS)}
      </div>

      <div class="tva-set-group" data-for="anthropic">
        <label class="tva-set-label" for="tva-key">API key</label>
        <input type="password" id="tva-key" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
        <p class="tva-set-hint">Stored in this extension only. Never sent to the page or to TradingView.</p>
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label" for="tva-base">Base URL</label>
        <input type="text" id="tva-base" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false">
        <p class="tva-set-hint">Ollama needs no key.</p>
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label" for="tva-key2">API key</label>
        <input type="password" id="tva-key2" placeholder="leave empty for Ollama" autocomplete="off" spellcheck="false">
      </div>

      <div class="tva-set-group" data-for="anthropic">
        <label class="tva-set-label">Model</label>
        ${segmented('model', MODELS)}
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label" for="tva-model2">Model</label>
        <input type="text" id="tva-model2" list="tva-models" placeholder="gemma4:26b-a4b-it-qat" autocomplete="off" spellcheck="false">
        <datalist id="tva-models"></datalist>
        <p class="tva-set-hint" id="tva-model-hint">Must be a model with tool support.</p>
      </div>

      <div class="tva-set-group" data-for="anthropic">
        <label class="tva-set-label">Effort</label>
        ${segmented('effort', EFFORTS)}
      </div>

      <div class="tva-set-group">
        <label class="tva-check">
          <input type="checkbox" id="tva-auto">
          <span>Run Pine edits without asking</span>
        </label>
      </div>
    `;

    const q = (sel) => hostEl.querySelector(sel);
    const keyEl = q('#tva-key');
    const key2El = q('#tva-key2');
    const baseEl = q('#tva-base');
    const model2El = q('#tva-model2');
    const autoEl = q('#tva-auto');
    const modelsEl = q('#tva-models');
    const hintEl = q('#tva-model-hint');

    const state = { provider: 'anthropic', model: 'claude-opus-5', effort: 'high' };

    function paintSegments() {
      hostEl.querySelectorAll('.tva-seg').forEach((seg) => {
        const value = state[seg.dataset.seg];
        seg.querySelectorAll('button').forEach((b) =>
          b.classList.toggle('on', b.dataset.value === value)
        );
      });
      hostEl.querySelectorAll('[data-for]').forEach((el) => {
        el.classList.toggle('tva-hidden', el.dataset.for !== state.provider);
      });
      onChange(current());
    }

    function current() {
      return {
        provider: state.provider,
        model: state.provider === 'anthropic' ? state.model : model2El.value.trim(),
        effort: state.effort,
      };
    }

    hostEl.querySelectorAll('.tva-seg').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        const field = seg.dataset.seg;
        state[field] = btn.dataset.value;
        const stored =
          field === 'provider' ? { provider: state.provider }
          : field === 'model' ? { model: state.model }
          : { effort: state.effort };
        chrome.storage.local.set(stored).then(field === 'provider' ? loadModels : () => {});
        paintSegments();
      });
    });

    keyEl.addEventListener('change', () =>
      chrome.storage.local.set({ apiKey: keyEl.value.trim() })
    );
    key2El.addEventListener('change', () =>
      chrome.storage.local.set({ openaiApiKey: key2El.value.trim() })
    );
    baseEl.addEventListener('change', () =>
      chrome.storage.local.set({ baseUrl: baseEl.value.trim() }).then(loadModels)
    );
    model2El.addEventListener('change', () => {
      chrome.storage.local.set({ openaiModel: model2El.value.trim() });
      onChange(current());
    });
    autoEl.addEventListener('change', () =>
      chrome.storage.local.set({ autoApprove: autoEl.checked })
    );

    /**
     * Fills the model list from the provider itself. The list belongs to a base
     * URL, so it is fetched once per URL and again when that URL changes.
     */
    let listedFor = null;
    async function loadModels() {
      const url = baseEl.value.trim();
      if (state.provider !== 'openai' || !url || listedFor === url) return;
      listedFor = url;

      hintEl.textContent = 'Loading models…';
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({ type: 'list-models' });
      } catch (err) {
        reply = { error: err.message || String(err) };
      }
      if (listedFor !== url) return; // a newer base URL took over

      const models = reply?.models || [];
      modelsEl.innerHTML = '';
      for (const m of models) {
        const option = document.createElement('option');
        option.value = m.id;
        if (m.tools === false) option.label = 'no tool support';
        modelsEl.appendChild(option);
      }

      if (reply?.error) {
        listedFor = null;
        hintEl.textContent = `Could not list models: ${reply.error} Type the name yourself.`;
      } else if (!models.length) {
        hintEl.textContent = 'The provider returned no models. Type the name yourself.';
      } else if (models.some((m) => m.tools !== null)) {
        hintEl.textContent = `${models.length} models — the ones without tool support are marked and listed last.`;
      } else {
        hintEl.textContent = `${models.length} models. It has to be one with tool support.`;
      }
    }

    const ready = chrome.storage.local
      .get(KEYS)
      .then(migrate)
      .then((s) => {
        state.provider = s.provider || 'anthropic';
        state.model = s.model || 'claude-opus-5';
        state.effort = s.effort || 'high';
        keyEl.value = s.apiKey || '';
        key2El.value = s.openaiApiKey || '';
        baseEl.value = s.baseUrl || 'http://localhost:11434/v1';
        model2El.value = s.openaiModel || '';
        autoEl.checked = !!s.autoApprove;
        paintSegments();
        // Anthropic cannot run without a key; a local provider can, but it
        // still has to be told which model to call.
        return state.provider === 'anthropic' ? !!s.apiKey : !!s.openaiModel;
      });

    return {
      ready,
      current,
      autoApprove: () => autoEl.checked,
      refresh: loadModels,
    };
  }

  return { create };
})();
