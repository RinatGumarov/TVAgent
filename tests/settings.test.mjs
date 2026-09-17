/**
 * Runs settings() and configError() from service-worker.js against a fake
 * chrome.storage, and checks what the request body carries per model.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSource, loadShared } from './helpers/load.mjs';

const src = readSource('background/service-worker.js');
const shared = loadShared('shared/models.js', 'shared/credentials.js', 'shared/provider-url.js');

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
    'TVAgentProviderURL',
    `${src}\nreturn { settings, configError, streamAnthropic };`,
  )(
    chromeStub(data),
    () => {},
    shared.TVAgentModels,
    shared.TVAgentCredentials,
    shared.TVAgentProviderURL,
  );

describe('the provider config', () => {
  it('anthropic: its own key and its own model', async () => {
    const { settings } = load({
      provider: 'anthropic',
      apiKey: 'sk-ant-real',
      model: 'claude-sonnet-5',
    });
    const cfg = await settings();
    assert.deepStrictEqual([cfg.apiKey, cfg.model], ['sk-ant-real', 'claude-sonnet-5']);
  });

  it('openai: the Anthropic key does not leak, and the model is its own', async () => {
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
    assert.deepStrictEqual([cfg.apiKey, cfg.model], ['', 'gemma4:26b-a4b-it-qat']);
  });

  it('openai: old storage is still readable', async () => {
    // Old storage: one shared slot for both. The provider is openai, so the
    // pair is its.
    const { settings } = load({
      provider: 'openai',
      apiKey: 'ollama-ignores-this',
      model: 'gemma4:26b-a4b-it-qat',
      baseUrl: 'http://localhost:11434/v1',
    });
    const cfg = await settings();
    assert.deepStrictEqual(
      [cfg.model, cfg.apiKey],
      ['gemma4:26b-a4b-it-qat', 'ollama-ignores-this'],
    );
  });

  it('openai: an sk-ant key in the shared slot stays put', async () => {
    const { settings } = load({
      provider: 'openai',
      apiKey: 'sk-ant-real',
      model: 'gemma4:26b-a4b-it-qat',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    const cfg = await settings();
    assert.deepStrictEqual([cfg.apiKey, cfg.model], ['', 'gemma4:26b-a4b-it-qat']);
  });

  it('openai: a claude model in the shared slot stays put, and one is asked for', async () => {
    // A model id from the Anthropic catalog in the shared slot stays behind
    // too; Ollama would 404 on it.
    const { settings, configError } = load({
      provider: 'openai',
      apiKey: '',
      model: 'claude-opus-5',
      baseUrl: 'http://localhost:11434/v1',
    });
    const cfg = await settings();
    assert.deepStrictEqual(cfg.model, '');
    assert.match(configError(cfg) || '', /model/i);
  });

  it('anthropic: the default model', async () => {
    const { settings } = load({ provider: 'anthropic' });
    const cfg = await settings();
    assert.deepStrictEqual(cfg.model, 'claude-opus-5');
  });
});

describe('the config check before a request', () => {
  const { configError } = load({});
  const err = (cfg) =>
    configError({ provider: 'anthropic', apiKey: '', model: '', baseUrl: '', ...cfg });

  it('anthropic with no key is refused', () => {
    assert.match(err({}) || '', /Anthropic API key/);
  });

  it('anthropic with a key is fine', () => {
    assert.deepStrictEqual(err({ apiKey: 'sk-ant' }), null);
  });

  it('openai with no model complains about the model, not an Anthropic key', () => {
    assert.match(err({ provider: 'openai', baseUrl: 'http://localhost:11434/v1' }) || '', /model/i);
  });

  it('openai with no key but a model is fine', () => {
    assert.deepStrictEqual(
      err({ provider: 'openai', model: 'gemma4:26b', baseUrl: 'http://localhost:11434/v1' }),
      null,
    );
  });

  it('a remote plaintext provider is refused before any request can carry data', () => {
    assert.match(
      err({ provider: 'openai', model: 'm', baseUrl: 'http://api.example.com/v1' }) || '',
      /HTTPS|localhost|127\.0\.0\.1/,
    );
  });

  it('a hosted HTTPS provider is accepted', () => {
    assert.deepStrictEqual(
      err({ provider: 'openai', model: 'm', baseUrl: 'https://api.example.com/v1' }),
      null,
    );
  });
});

// ---- what the request body carries -----------------------------------------

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
    'TVAgentProviderURL',
    `${src}\nreturn { streamAnthropic };`,
  )(
    chromeStub({}),
    fetchStub,
    () => {},
    shared.TVAgentModels,
    shared.TVAgentCredentials,
    shared.TVAgentProviderURL,
  );

  await worker
    .streamAnthropic(
      { model, apiKey: 'sk-ant', maxTokens: 32000, effort: 'high' },
      { system: 's', messages: [], tools: [] },
      { postMessage() {} },
      undefined,
    )
    .catch(() => {});
  return sent;
}

describe('reasoning fields per model', () => {
  it('opus 5 asks for adaptive thinking and carries an effort', async () => {
    const opus = await bodyFor('claude-opus-5');
    assert.deepStrictEqual(opus.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepStrictEqual(opus.output_config, { effort: 'high' });
  });

  it('haiku 4.5 gets an explicit budget instead, and no effort field', async () => {
    const haiku = await bodyFor('claude-haiku-4-5');
    assert.deepStrictEqual(haiku.thinking?.type, 'enabled');
    assert.ok(haiku.thinking?.budget_tokens < 32000);
    assert.deepStrictEqual('output_config' in haiku, false);
  });

  it('an unknown model gets neither', async () => {
    const unknown = await bodyFor('some-model-we-have-never-heard-of');
    assert.deepStrictEqual(['thinking' in unknown, 'output_config' in unknown], [false, false]);
  });
});
