/**
 * TVAgent — provider settings: what actually goes out in a request, and what
 * the panel shows.
 *
 * Runs the real service-worker.js against a fake chrome.storage, and the real
 * panel.css against the path to a settings field. It guards exactly what
 * broke: the OpenAI-compatible provider selected while the request went to
 * Anthropic, and the other provider's fields left on screen.
 *
 *   node settings-test.mjs
 */
import fs from 'node:fs';
import { check, section, report } from './helpers/check.mjs';
import { EXT, readSource, loadShared } from './helpers/load.mjs';

const src = readSource('background/service-worker.js');
const shared = loadShared('shared/models.js', 'shared/credentials.js');

// ---- the worker under a fake chrome ----------------------------------------

/** get() returns only the keys asked for, or the test would miss a forgotten one. */
const chromeStub = (data) => ({
  action: { onClicked: { addListener() {} } },
  runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
  tabs: { sendMessage: () => Promise.resolve() },
  storage: {
    local: {
      get: async (keys) =>
        Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])),
    },
  },
});

const load = (data) =>
  new Function(
    'chrome',
    'importScripts',
    'TVAgentModels',
    'TVAgentCredentials',
    `${src}\nreturn { settings, configError, streamAnthropic };`
  )(chromeStub(data), () => {}, shared.TVAgentModels, shared.TVAgentCredentials);

section('the provider config');

{
  const { settings } = load({ provider: 'anthropic', apiKey: 'sk-ant-real', model: 'claude-sonnet-5' });
  const cfg = await settings();
  check('anthropic: its own key and its own model', [cfg.apiKey, cfg.model], ['sk-ant-real', 'claude-sonnet-5']);
}

{
  // The Anthropic key sits in its own slot and must not go out as a bearer
  // token to somebody else's host.
  const { settings } = load({
    provider: 'openai',
    apiKey: 'sk-ant-real',
    model: 'claude-opus-5',
    openaiModel: 'gemma4:26b-a4b-it-qat',
    openaiApiKey: '',
    baseUrl: 'http://localhost:11434/v1',
  });
  const cfg = await settings();
  check('openai: the Anthropic key does not leak', cfg.apiKey, '');
  check('openai: its own model, not a claude one', cfg.model, 'gemma4:26b-a4b-it-qat');
}

{
  // Old storage: one shared slot for both. The provider is openai, so the
  // model and key in it are its.
  const { settings } = load({
    provider: 'openai',
    apiKey: 'ollama-ignores-this',
    model: 'gemma4:26b-a4b-it-qat',
    baseUrl: 'http://localhost:11434/v1',
  });
  const cfg = await settings();
  check('openai: old storage is still readable', [cfg.model, cfg.apiKey], ['gemma4:26b-a4b-it-qat', 'ollama-ignores-this']);
}

{
  // The same shared slot, but with an Anthropic key in it: it got there from
  // the Anthropic field and must not travel as a bearer token elsewhere.
  const { settings } = load({
    provider: 'openai',
    apiKey: 'sk-ant-real',
    model: 'gemma4:26b-a4b-it-qat',
    baseUrl: 'https://api.groq.com/openai/v1',
  });
  const cfg = await settings();
  check('openai: an sk-ant key in the shared slot stays put', [cfg.apiKey, cfg.model], ['', 'gemma4:26b-a4b-it-qat']);
}

{
  // And the other half of the same ambiguity: a shared slot holding a model
  // id from our own Anthropic catalog. Sending "claude-opus-5" to Ollama is
  // not a degraded answer, it is a 404 — so it stays behind, and the panel is
  // told to pick a model instead.
  const { settings, configError } = load({
    provider: 'openai',
    apiKey: '',
    model: 'claude-opus-5',
    baseUrl: 'http://localhost:11434/v1',
  });
  const cfg = await settings();
  check('openai: a claude model in the shared slot stays put', cfg.model, '');
  check('and the user is asked for one', /model/i.test(configError(cfg) || ''), true);
}

{
  const { settings } = load({ provider: 'anthropic' });
  const cfg = await settings();
  check('anthropic: the default model', cfg.model, 'claude-opus-5');
}

section('the config check before a request');

{
  const { configError } = load({});
  const err = (cfg) => configError({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '', ...cfg });

  check('anthropic with no key is refused', /Anthropic API key/.test(err({}) || ''), true);
  check('anthropic with a key is fine', err({ apiKey: 'sk-ant' }), null);
  check(
    'openai with no model complains about the model, not an Anthropic key',
    /model/i.test(err({ provider: 'openai', baseUrl: 'http://localhost:11434/v1' }) || ''),
    true
  );
  check(
    'openai with no key but a model is fine',
    err({ provider: 'openai', model: 'gemma4:26b', baseUrl: 'http://localhost:11434/v1' }),
    null
  );
}

// ---- what the request body carries -----------------------------------------

section('reasoning fields per model');

/**
 * Haiku 4.5 takes neither adaptive thinking nor output_config.effort, and
 * rejects a request carrying them rather than ignoring the fields. Both went
 * out on every request regardless of model, which made a model the settings
 * screen openly offered fail every single turn with a 400.
 */
async function bodyFor(model) {
  let sent = null;
  const fetchStub = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    throw new Error('stop here — the body is what is under test');
  };
  const worker = new Function(
    'chrome',
    'fetch',
    'importScripts',
    'TVAgentModels',
    'TVAgentCredentials',
    `${src}\nreturn { streamAnthropic };`
  )(chromeStub({}), fetchStub, () => {}, shared.TVAgentModels, shared.TVAgentCredentials);

  await worker
    .streamAnthropic(
      { model, apiKey: 'sk-ant', maxTokens: 32000, effort: 'high' },
      { system: 's', messages: [], tools: [] },
      { postMessage() {} },
      undefined
    )
    .catch(() => {});
  return sent;
}

{
  const opus = await bodyFor('claude-opus-5');
  check('opus 5 asks for adaptive thinking', opus.thinking, { type: 'adaptive', display: 'summarized' });
  check('opus 5 carries an effort', opus.output_config, { effort: 'high' });
}

{
  const haiku = await bodyFor('claude-haiku-4-5');
  check('haiku 4.5 gets an explicit budget instead', haiku.thinking?.type, 'enabled');
  check('with room left for the answer', haiku.thinking?.budget_tokens < 32000, true);
  check('and no effort field at all', 'output_config' in haiku, false);
}

{
  const unknown = await bodyFor('some-model-we-have-never-heard-of');
  check('an unknown model gets neither', ['thinking' in unknown, 'output_config' in unknown], [false, false]);
}

// ---- field visibility in the settings screen -------------------------------

section('settings fields');

/**
 * A tiny matcher: descendant combinators and compounds of #id/.class/tag, which
 * is all panel.css's selectors need.
 */
function matches(selector, path) {
  const parts = selector.trim().split(/\s+/);
  let i = path.length - 1;
  let j = parts.length - 1;
  if (!matchCompound(parts[j], path[i])) return false;
  i--; j--;
  while (j >= 0) {
    if (i < 0) return false;
    if (matchCompound(parts[j], path[i])) j--;
    i--;
  }
  return true;
}

function matchCompound(compound, el) {
  if (!el) return false;
  const tag = compound.match(/^[a-z]+/i);
  if (tag && tag[0] !== el.tag) return false;
  for (const id of compound.match(/#[\w-]+/g) || []) if (id.slice(1) !== el.id) return false;
  for (const cls of compound.match(/\.[\w-]+/g) || []) if (!el.classes.includes(cls.slice(1))) return false;
  // Pseudo-classes like :last-child are not needed here — none are about display.
  return !/:/.test(compound.replace(/:(hover|focus|last-child|first-child)\b/g, ''));
}

const css = fs.readFileSync(`${EXT}content/panel.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => {
  const raw = (body.match(/display\s*:\s*([^;]+)/) || [])[1]?.trim();
  return {
    selectors: sel.split(',').map((s) => s.trim()).filter(Boolean),
    // `!important` (used by .tva-hidden so a later same-specificity rule with
    // its own `display` — e.g. .tva-list's `display: flex` — cannot win the
    // cascade) has to be stripped from the value here for the string compares
    // below, but its priority still has to be modeled separately — see
    // displayFor, which is otherwise a plain "last matching rule wins"
    // evaluator and would miss the exact bug this guards against.
    display: raw?.replace(/\s*!important$/, ''),
    important: /!important\s*$/.test(raw || ''),
  };
});

/** The other provider's group: <div class="tva-set-group tva-hidden" data-for="anthropic"> */
const hiddenField = [
  { tag: 'div', id: 'tva-root', classes: [] },
  { tag: 'div', id: 'tva-settings', classes: ['tva-settings'] },
  { tag: 'div', id: null, classes: ['tva-set-group', 'tva-hidden'] },
];
const visibleField = [
  hiddenField[0],
  hiddenField[1],
  { tag: 'div', id: null, classes: ['tva-set-group'] },
];

/**
 * The four elements panel.js itself toggles .tva-hidden on (showScreen()).
 * #tva-list is the one that actually broke: .tva-list's own `display: flex`
 * rule, declared later in the file at equal specificity, won the cascade over
 * .tva-hidden's `display: none` and left the message list visible behind the
 * settings screen. The other three passed only because no later rule happens
 * to set `display` on them — incidental, not structural — so they get the same
 * guard here.
 */
const hiddenList = [
  { tag: 'div', id: 'tva-root', classes: [] },
  { tag: 'div', id: null, classes: ['tva-body'] },
  { tag: 'div', id: 'tva-list', classes: ['tva-list', 'tva-hidden'] },
];
const hiddenEmpty = [
  hiddenList[0],
  hiddenList[1],
  { tag: 'div', id: 'tva-empty', classes: ['tva-empty', 'tva-hidden'] },
];
const hiddenSettings = [
  hiddenList[0],
  hiddenList[1],
  { tag: 'div', id: 'tva-settings', classes: ['tva-settings', 'tva-hidden'] },
];
const hiddenComposer = [
  hiddenList[0],
  { tag: 'footer', id: null, classes: ['tva-composer', 'tva-hidden'] },
];
/**
 * The fifth toggle is the composer's context popover. It would hit the same
 * cascade trap first: it has no display of its own, so it stays closed on
 * .tva-hidden alone, and any future rule setting display on .tva-ctx-pop (say
 * display:grid for the rows) is declared later and at equal specificity would
 * win — leaving the popover stuck open.
 */
const hiddenCtxPop = [
  hiddenList[0],
  { tag: 'footer', id: null, classes: ['tva-composer'] },
  { tag: 'div', id: null, classes: ['tva-composer-chips'] },
  { tag: 'div', id: 'tva-ctx-pop', classes: ['tva-ctx-pop', 'tva-hidden'] },
];
const visibleCtxPop = [
  hiddenCtxPop[0],
  hiddenCtxPop[1],
  hiddenCtxPop[2],
  { tag: 'div', id: 'tva-ctx-pop', classes: ['tva-ctx-pop'] },
];

const displayFor = (path) => {
  let value = 'block';
  let importantWon = false;
  for (const rule of rules) {
    if (!rule.display) continue;
    if (!rule.selectors.some((s) => matches(s, path))) continue;
    // Once an !important declaration has matched, only a later !important
    // declaration can still override it — same tiering the real cascade uses,
    // and the reason .tva-hidden's `display: none !important` beats .tva-list's
    // later, merely-equal-specificity `display: flex`.
    if (importantWon && !rule.important) continue;
    value = rule.display;
    if (rule.important) importantWon = true;
  }
  return value;
};

check('a field with .tva-hidden is hidden', displayFor(hiddenField), 'none');
check('an ordinary field is visible', displayFor(visibleField) !== 'none', true);
check('a hidden list is hidden', displayFor(hiddenList), 'none');
check('a hidden empty state is hidden', displayFor(hiddenEmpty), 'none');
check('a hidden settings screen is hidden', displayFor(hiddenSettings), 'none');
check('a hidden composer is hidden', displayFor(hiddenComposer), 'none');
check('a closed context popover is hidden', displayFor(hiddenCtxPop), 'none');
check('an open context popover is visible', displayFor(visibleCtxPop) !== 'none', true);

report();
