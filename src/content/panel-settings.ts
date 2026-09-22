/**
 * TVAgent — settings screen.
 *
 * Provider, model and effort as segmented controls. API keys are not here:
 * they are typed on the extension's options page, and this screen only asks
 * the worker whether one is set.
 */

import * as TVAgentModels from '../shared/models.ts';
import * as TVAgentProviderURL from '../shared/provider-url.ts';
import { PRIVACY_URL } from './panel-consent.ts';

/** What the screen reads out of chrome.storage.local. */
export interface StoredSettings {
  provider?: string;
  model?: string;
  openaiModel?: string;
  baseUrl?: string;
  effort?: string;
  openaiEffort?: string;
  autoApprove?: boolean;
  dataDisclosureAccepted?: boolean;
}

/** Which providers have a key, as the worker reports it. */
interface KeyStatus {
  anthropic: boolean;
  openai: boolean;
}

/** One entry from the provider's model list. `tools` is null when unknown. */
interface ListedModel {
  id: string;
  tools: boolean | null;
}

interface ModelsReply {
  models?: ListedModel[];
  error?: string;
}

/** What the panel is told after every change. */
export interface SettingsSelection {
  provider: string;
  model: string;
  effort: string;
}

/** Everything the screen keeps, including what the panel is not told. */
interface SettingsState extends SettingsSelection {
  openaiEffort: string;
  keys: KeyStatus;
  accepted: boolean;
  providerAllowed: boolean;
  providerBaseUrl: string | null;
}

/** The segmented controls, keyed as their data-seg attribute spells them. */
type SegmentKey = 'provider' | 'model' | 'effort' | 'openaiEffort';

const KEYS = [
  'model',
  'effort',
  'autoApprove',
  'provider',
  'baseUrl',
  'openaiModel',
  'openaiEffort',
  'dataDisclosureAccepted',
];

const MODELS = TVAgentModels.ANTHROPIC;

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Xhigh' },
];

/** Auto leaves the field out; Off asks the provider not to reason at all. */
const OPENAI_EFFORTS = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI-compatible' },
];

function segmented(name: string, options: Array<{ id?: string; value?: string; label: string }>) {
  return (
    `<div class="tva-seg" data-seg="${name}">` +
    options
      .map((o) => `<button type="button" data-value="${o.id || o.value}">${o.label}</button>`)
      .join('') +
    '</div>'
  );
}

function create(
  hostEl: HTMLElement,
  { onChange, onRevoke }: { onChange: (s: SettingsSelection) => void; onRevoke: () => void },
) {
  hostEl.innerHTML = `
      <div class="tva-set-group">
        <label class="tva-set-label">Provider</label>
        ${segmented('provider', PROVIDERS)}
      </div>

      <div class="tva-set-group">
        <label class="tva-set-label">API key</label>
        <div>
          <span class="tva-key-status" id="tva-key-status"></span>
          <button class="tva-secondary" id="tva-key-manage" type="button">Manage key</button>
        </div>
        <p class="tva-set-hint">Keys are entered on the extension's options page, never on this page.</p>
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label" for="tva-base">Base URL</label>
        <input type="text" id="tva-base" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false">
        <p class="tva-set-hint" id="tva-base-hint">Hosted providers must use HTTPS. Ollama on localhost needs no key.</p>
        <button class="tva-secondary tva-hidden" id="tva-provider-access" type="button">Allow provider access</button>
      </div>

      <div class="tva-set-group" data-for="anthropic">
        <label class="tva-set-label">Model</label>
        ${segmented('model', MODELS)}
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label" for="tva-model2">Model</label>
        <div class="tva-combo">
          <input type="text" id="tva-model2" placeholder="gemma4:26b-a4b-it-qat" autocomplete="off" spellcheck="false" role="combobox" aria-controls="tva-models" aria-expanded="false">
          <div class="tva-combo-list tva-hidden" id="tva-models" role="listbox"></div>
        </div>
        <p class="tva-set-hint" id="tva-model-hint">Must be a model with tool support.</p>
      </div>

      <div class="tva-set-group" data-for="anthropic">
        <label class="tva-set-label">Effort</label>
        ${segmented('effort', EFFORTS)}
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label">Effort</label>
        ${segmented('openaiEffort', OPENAI_EFFORTS)}
        <p class="tva-set-hint">Off is the fastest. Auto leaves it to the provider; a model that cannot reason ignores the rest.</p>
      </div>

      <div class="tva-set-group">
        <label class="tva-check">
          <input type="checkbox" id="tva-auto">
          <span>Run Pine edits without asking</span>
        </label>
      </div>

      <p class="tva-set-foot">
        Data use agreed ·
        <a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy policy</a> ·
        <button class="tva-link" id="tva-disclosure-revoke" type="button">Revoke</button>
      </p>
    `;

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = hostEl.querySelector<T>(sel);
    if (!el) throw new Error(`TVAgent settings is missing ${sel}.`);
    return el;
  };
  const keyStatusEl = q('#tva-key-status');
  const baseEl = q<HTMLInputElement>('#tva-base');
  const baseHintEl = q('#tva-base-hint');
  const accessEl = q('#tva-provider-access');
  const model2El = q<HTMLInputElement>('#tva-model2');
  const autoEl = q<HTMLInputElement>('#tva-auto');
  const modelsEl = q('#tva-models');
  const hintEl = q('#tva-model-hint');

  const state: SettingsState = {
    provider: 'anthropic',
    model: TVAgentModels.DEFAULT_MODEL,
    effort: 'high',
    openaiEffort: 'auto',
    keys: { anthropic: false, openai: false },
    accepted: false,
    providerAllowed: true,
    providerBaseUrl: null,
  };

  function paintSegments() {
    hostEl.querySelectorAll<HTMLElement>('.tva-seg').forEach((seg) => {
      const value = state[seg.dataset.seg as SegmentKey];
      seg
        .querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.value === value));
    });
    hostEl.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => {
      el.classList.toggle('tva-hidden', el.dataset.for !== state.provider);
    });
    accessEl.classList.toggle('tva-hidden', state.provider !== 'openai' || state.providerAllowed);
    const hasKey = state.provider === 'anthropic' ? state.keys.anthropic : state.keys.openai;
    keyStatusEl.textContent = hasKey
      ? 'Set'
      : state.provider === 'anthropic'
        ? 'Not set'
        : 'Not set — fine for a local provider';
    keyStatusEl.classList.toggle('on', hasKey);
    onChange(current());
  }

  async function loadKeyStatus() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'key-status' });
      state.keys = { anthropic: !!reply?.anthropic, openai: !!reply?.openai };
    } catch (_) {
      state.keys = { anthropic: false, openai: false };
    }
  }

  function current(): SettingsSelection {
    return {
      provider: state.provider,
      model: state.provider === 'anthropic' ? state.model : model2El.value.trim(),
      effort: state.provider === 'anthropic' ? state.effort : state.openaiEffort,
    };
  }

  function isReady() {
    if (!state.accepted) return false;
    if (state.provider === 'anthropic') return state.keys.anthropic;
    return !!model2El.value.trim() && state.providerAllowed && validProvider(false);
  }

  function validProvider(showError = true) {
    try {
      TVAgentProviderURL.parse(baseEl.value);
      return true;
    } catch (err) {
      if (showError) baseHintEl.textContent = (err as Error).message || String(err);
      return false;
    }
  }

  async function providerPermission(request: boolean) {
    if (state.provider !== 'openai') {
      state.providerAllowed = true;
      paintSegments();
      return true;
    }

    let parsed;
    try {
      parsed = TVAgentProviderURL.parse(baseEl.value);
    } catch (err) {
      state.providerAllowed = false;
      baseHintEl.textContent = (err as Error).message || String(err);
      paintSegments();
      return false;
    }
    state.providerBaseUrl = parsed.baseUrl;

    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'provider-permission',
        action: request ? 'request' : 'contains',
        baseUrl: parsed.baseUrl,
      });
      if (reply?.error) throw new Error(reply.error);
      state.providerAllowed = !!reply?.granted;
    } catch (err) {
      state.providerAllowed = false;
      baseHintEl.textContent = request
        ? `Chrome could not grant provider access: ${(err as Error).message || String(err)}`
        : 'Allow access to this provider before sending chart data.';
      paintSegments();
      return false;
    }
    baseHintEl.textContent = state.providerAllowed
      ? `Access allowed for ${new URL(parsed.baseUrl).hostname}.`
      : 'Allow access to this provider before sending chart data.';
    paintSegments();
    return state.providerAllowed;
  }

  async function revokeProviderPermission(baseUrl: string | null) {
    if (!baseUrl) return false;
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'provider-permission',
        action: 'remove',
        baseUrl,
      });
      if (reply?.error) throw new Error(reply.error);
      return !!reply?.removed;
    } catch (err) {
      console.warn('[TVAgent] could not revoke obsolete provider access:', err);
      return false;
    }
  }

  hostEl.querySelectorAll<HTMLElement>('.tva-seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = (e.target as Element | null)?.closest<HTMLElement>('button[data-value]');
      if (!btn) return;
      const field = seg.dataset.seg as SegmentKey;
      state[field] = btn.dataset.value ?? '';
      // Each control is named after the storage key it writes.
      chrome.storage.local.set({ [field]: state[field] }).then(async () => {
        if (field !== 'provider') return;
        if (state.provider === 'anthropic' && state.providerBaseUrl) {
          await revokeProviderPermission(state.providerBaseUrl);
          state.providerBaseUrl = null;
        }
        await providerPermission(false);
        await loadModels();
      });
      paintSegments();
    });
  });

  q('#tva-key-manage').addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: 'open-options' }),
  );
  q('#tva-disclosure-revoke').addEventListener('click', async () => {
    state.accepted = false;
    await chrome.storage.local.set({ dataDisclosureAccepted: false });
    onRevoke();
  });
  // A key saved on the options page shows up here, and may unlock a model list.
  chrome.storage.onChanged?.addListener(async (changes, area) => {
    if (area !== 'local' || !('apiKey' in changes || 'openaiApiKey' in changes)) return;
    await loadKeyStatus();
    listedFor = null;
    paintSegments();
  });
  baseEl.addEventListener('change', async () => {
    const previousBaseUrl = state.providerBaseUrl;
    let parsed;
    try {
      parsed = TVAgentProviderURL.parse(baseEl.value);
    } catch (err) {
      state.providerAllowed = false;
      baseHintEl.textContent = (err as Error).message || String(err);
      paintSegments();
      return;
    }
    baseEl.value = parsed.baseUrl;
    listedFor = null;
    await chrome.storage.local.set({ baseUrl: parsed.baseUrl });
    const previousPermission = previousBaseUrl
      ? TVAgentProviderURL.parse(previousBaseUrl).permission
      : null;
    if (previousPermission && previousPermission !== parsed.permission) {
      await revokeProviderPermission(previousBaseUrl);
    }
    await providerPermission(false);
    if (state.providerAllowed) await loadModels();
  });
  accessEl.addEventListener('click', async () => {
    if (await providerPermission(true)) await loadModels();
  });
  const saveModel = () => {
    chrome.storage.local.set({ openaiModel: model2El.value.trim() });
    onChange(current());
  };
  model2El.addEventListener('change', saveModel);

  /**
   * The model list under the field. Focus shows all of it and typing narrows
   * it, so a name already in the field does not hide the others.
   */
  let listed: ListedModel[] = [];
  function showModels(filter = '') {
    const needle = filter.trim().toLowerCase();
    const shown = listed.filter((m) => m.id.toLowerCase().includes(needle));
    modelsEl.innerHTML = '';
    for (const m of shown) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'tva-combo-option';
      option.setAttribute('role', 'option');
      option.setAttribute('data-value', m.id);
      option.textContent = m.id;
      if (m.tools === false) {
        const note = document.createElement('i');
        note.textContent = 'no tool support';
        option.appendChild(note);
      }
      option.classList.toggle('on', m.id === model2El.value.trim());
      modelsEl.appendChild(option);
    }
    modelsEl.classList.toggle('tva-hidden', !shown.length);
    model2El.setAttribute('aria-expanded', String(!!shown.length));
  }
  function hideModels() {
    modelsEl.classList.add('tva-hidden');
    model2El.setAttribute('aria-expanded', 'false');
  }
  model2El.addEventListener('focus', () => showModels());
  model2El.addEventListener('input', () => showModels(model2El.value));
  model2El.addEventListener('blur', hideModels);
  model2El.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideModels();
  });
  // Keeps focus in the field, so the click lands before blur hides the list.
  modelsEl.addEventListener('mousedown', (e) => e.preventDefault());
  modelsEl.addEventListener('click', (e) => {
    const option = (e.target as Element | null)?.closest<HTMLElement>('[data-value]');
    if (!option) return;
    model2El.value = option.dataset.value ?? '';
    hideModels();
    saveModel();
  });
  autoEl.addEventListener('change', () =>
    chrome.storage.local.set({ autoApprove: autoEl.checked }),
  );

  /**
   * Fills the model list from the provider itself. The list belongs to a base
   * URL, so it is fetched once per URL and again when that URL changes.
   */
  let listedFor: string | null = null;
  async function loadModels() {
    let parsed;
    try {
      parsed = TVAgentProviderURL.parse(baseEl.value);
    } catch (err) {
      baseHintEl.textContent = (err as Error).message || String(err);
      return;
    }
    const url = parsed.baseUrl;
    if (state.provider !== 'openai' || !url || listedFor === url) return;
    if (!(await providerPermission(false))) {
      listedFor = null;
      return;
    }
    listedFor = url;

    hintEl.textContent = 'Loading models…';
    let reply: ModelsReply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'list-models' });
    } catch (err) {
      reply = { error: (err as Error).message || String(err) };
    }
    if (listedFor !== url) return; // a newer base URL took over

    const models: ListedModel[] = reply?.models || [];
    listed = models;

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

  // The worker migrates an old profile while answering, so it is asked first.
  const ready = loadKeyStatus()
    .then(() => chrome.storage.local.get(KEYS))
    .then(async (s: StoredSettings) => {
      state.provider = s.provider || 'anthropic';
      state.model = s.model || TVAgentModels.DEFAULT_MODEL;
      state.effort = s.effort || 'high';
      state.openaiEffort = s.openaiEffort || 'auto';
      state.accepted = !!s.dataDisclosureAccepted;
      baseEl.value = s.baseUrl || 'http://localhost:11434/v1';
      model2El.value = s.openaiModel || '';
      autoEl.checked = !!s.autoApprove;
      if (state.provider === 'openai') await providerPermission(false);
      paintSegments();
      return isReady();
    });

  return {
    ready,
    current,
    isReady,
    accepted: () => state.accepted,
    setAccepted(accepted: boolean) {
      state.accepted = accepted;
    },
    autoApprove: () => autoEl.checked,
    async refresh() {
      await loadKeyStatus();
      paintSegments();
      await loadModels();
    },
  };
}

export { create };
