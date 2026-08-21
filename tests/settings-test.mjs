/**
 * Runs settings() and configError() from service-worker.js against a fake
 * chrome.storage, and checks what the request body carries per model.
 */
import { check, section, report } from './helpers/check.mjs';
import { readSource, loadShared } from './helpers/load.mjs';

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
  // token to another host.
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
  // pair is its.
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
  // The same shared slot with an Anthropic key in it: it stays behind.
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
  // A model id from the Anthropic catalog in the shared slot stays behind
  // too; Ollama would 404 on it.
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
 * rejects a request carrying them.
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

report();
