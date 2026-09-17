/**
 * TVAgent — settings screen.
 *
 * Provider, model and effort as segmented controls. The API key fields live in
 * closed shadow roots so that no script on the page can read them; see
 * secretField.
 */

import * as TVAgentModels from '../shared/models.ts';
import * as TVAgentCredentials from '../shared/credentials.ts';
import * as TVAgentProviderURL from '../shared/provider-url.ts';
import type { StoredCredentials } from '../shared/credentials.ts';

/** What the screen reads out of chrome.storage.local. */
export interface StoredSettings extends StoredCredentials {
  baseUrl?: string;
  effort?: string;
  autoApprove?: boolean;
  dataDisclosureAccepted?: boolean;
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
  accepted: boolean;
  providerAllowed: boolean;
  providerBaseUrl: string | null;
}

/** The segmented controls, keyed as their data-seg attribute spells them. */
type SegmentKey = 'provider' | 'model' | 'effort';

const KEYS = [
  'apiKey',
  'model',
  'effort',
  'autoApprove',
  'provider',
  'baseUrl',
  'openaiApiKey',
  'openaiModel',
  'dataDisclosureAccepted',
];

const MODELS = TVAgentModels.ANTHROPIC;

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
 * A password field the rest of the page cannot read: with a closed shadow
 * root the host reports shadowRoot === null and the only reference to the
 * input lives in this closure. Custom properties still inherit through, so
 * it is painted in TradingView's tokens.
 */
function secretField(host: HTMLElement, { placeholder }: { placeholder: string }) {
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
      <style>
        input {
          box-sizing: border-box;
          width: 100%;
          background: none;
          color: var(--tva-fg);
          border: 1px solid var(--tva-border);
          border-radius: 6px;
          padding: 7px 9px;
          font: inherit;
          font-size: 12px;
          outline: none;
        }
        input:focus { border-color: var(--tva-accent); }
      </style>
      <input type="password" autocomplete="off" spellcheck="false">
    `;
  const input = shadow.querySelector('input')!;
  input.placeholder = placeholder;
  return {
    get value() {
      return input.value.trim();
    },
    set value(v) {
      input.value = v || '';
    },
    onChange: (fn: EventListener) => input.addEventListener('change', fn),
  };
}

/**
 * Moves a profile off the old shared key/model slot; the rules live in
 * shared/credentials.js because the worker reads the same way.
 */
function migrate(s: StoredSettings): StoredSettings {
  const slots = TVAgentCredentials.split(s);
  if (!slots.changed) return s;
  const moved = {
    apiKey: slots.apiKey,
    model: slots.model,
    openaiApiKey: slots.openaiApiKey,
    openaiModel: slots.openaiModel,
  };
  chrome.storage.local.set(moved);
  return { ...s, ...moved };
}

function segmented(name: string, options: Array<{ id?: string; value?: string; label: string }>) {
  return (
    `<div class="tva-seg" data-seg="${name}">` +
    options
      .map((o) => `<button type="button" data-value="${o.id || o.value}">${o.label}</button>`)
      .join('') +
    '</div>'
  );
}

function create(hostEl: HTMLElement, { onChange }: { onChange: (s: SettingsSelection) => void }) {
  hostEl.innerHTML = `
      <section class="tva-disclosure" id="tva-disclosure">
        <h2>Before you send chart data</h2>
        <p>When you send a message, TVAgent sends your prompts and conversation,
          chart context, recent OHLCV bars, indicators, drawings, strategy values,
          and any Pine source you ask it to work on to your selected model provider.</p>
        <p>Your API key is sent only to the selected model provider to
          authenticate its API request. The TVAgent developer and TradingView do
          not receive your prompts or model credentials.</p>
        <a href="https://github.com/RinatGumarov/TVAgent/blob/main/PRIVACY.md"
          target="_blank" rel="noopener noreferrer">Read the privacy policy</a>
        <label class="tva-check tva-disclosure-check">
          <input type="checkbox" id="tva-disclosure-accept">
          <span>I understand and agree to this data use</span>
        </label>
      </section>

      <div class="tva-set-group">
        <label class="tva-set-label">Provider</label>
        ${segmented('provider', PROVIDERS)}
      </div>

      <div class="tva-set-group" data-for="anthropic">
        <label class="tva-set-label">API key</label>
        <div class="tva-secret" id="tva-key"></div>
        <p class="tva-set-hint">Stored locally and sent only to Anthropic for authentication. Never sent to the page or TradingView.</p>
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label" for="tva-base">Base URL</label>
        <input type="text" id="tva-base" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false">
        <p class="tva-set-hint" id="tva-base-hint">Hosted providers must use HTTPS. Ollama on localhost needs no key.</p>
        <button class="tva-secondary tva-hidden" id="tva-provider-access" type="button">Allow provider access</button>
      </div>

      <div class="tva-set-group" data-for="openai">
        <label class="tva-set-label">API key</label>
        <div class="tva-secret" id="tva-key2"></div>
        <p class="tva-set-hint">Stored locally and sent only to the configured provider for authentication.</p>
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

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => {
    const el = hostEl.querySelector<T>(sel);
    if (!el) throw new Error(`TVAgent settings is missing ${sel}.`);
    return el;
  };
  const keyEl = secretField(q('#tva-key'), { placeholder: 'sk-ant-...' });
  const key2El = secretField(q('#tva-key2'), { placeholder: 'leave empty for Ollama' });
  const baseEl = q<HTMLInputElement>('#tva-base');
  const baseHintEl = q('#tva-base-hint');
  const accessEl = q('#tva-provider-access');
  const model2El = q<HTMLInputElement>('#tva-model2');
  const autoEl = q<HTMLInputElement>('#tva-auto');
  const disclosureEl = q<HTMLInputElement>('#tva-disclosure-accept');
  const modelsEl = q('#tva-models');
  const hintEl = q('#tva-model-hint');

  const state: SettingsState = {
    provider: 'anthropic',
    model: TVAgentModels.DEFAULT_MODEL,
    effort: 'high',
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
    onChange(current());
  }

  function current(): SettingsSelection {
    return {
      provider: state.provider,
      model: state.provider === 'anthropic' ? state.model : model2El.value.trim(),
      effort: state.effort,
    };
  }

  function isReady() {
    if (!state.accepted) return false;
    if (state.provider === 'anthropic') return !!keyEl.value;
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
      const stored: Record<string, string> =
        field === 'provider'
          ? { provider: state.provider }
          : field === 'model'
            ? { model: state.model }
            : { effort: state.effort };
      chrome.storage.local.set(stored).then(async () => {
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

  keyEl.onChange(() => chrome.storage.local.set({ apiKey: keyEl.value }));
  key2El.onChange(() => chrome.storage.local.set({ openaiApiKey: key2El.value }));
  disclosureEl.addEventListener('change', () => {
    state.accepted = !!disclosureEl.checked;
    chrome.storage.local.set({ dataDisclosureAccepted: state.accepted });
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
  model2El.addEventListener('change', () => {
    chrome.storage.local.set({ openaiModel: model2El.value.trim() });
    onChange(current());
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
    .then(async (s) => {
      state.provider = s.provider || 'anthropic';
      state.model = s.model || TVAgentModels.DEFAULT_MODEL;
      state.effort = s.effort || 'high';
      state.accepted = !!s.dataDisclosureAccepted;
      keyEl.value = s.apiKey || '';
      key2El.value = s.openaiApiKey || '';
      baseEl.value = s.baseUrl || 'http://localhost:11434/v1';
      model2El.value = s.openaiModel || '';
      autoEl.checked = !!s.autoApprove;
      disclosureEl.checked = state.accepted;
      if (state.provider === 'openai') await providerPermission(false);
      paintSegments();
      return isReady();
    });

  return {
    ready,
    current,
    isReady,
    autoApprove: () => autoEl.checked,
    refresh: loadModels,
  };
}

export { create };
