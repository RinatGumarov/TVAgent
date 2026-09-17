/** Runs listModels() from service-worker.js against a stubbed fetch. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSource, loadShared } from './helpers/load.mjs';

const src = readSource('background/service-worker.js');
const shared = loadShared('shared/models.js', 'shared/credentials.js');

const chromeStub = {
  action: { onClicked: { addListener() {} } },
  runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
  tabs: { sendMessage: () => Promise.resolve() },
  storage: { local: { get: async () => ({}) } },
};

const load = (fetchStub) =>
  new Function(
    'chrome',
    'fetch',
    'importScripts',
    'TVAgentModels',
    'TVAgentCredentials',
    `${src}\nreturn { listModels };`,
  )(chromeStub, fetchStub, () => {}, shared.TVAgentModels, shared.TVAgentCredentials);

const json = (body, status = 200) => ({
  ok: status < 300,
  status,
  statusText: 'x',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const OLLAMA = {
  provider: 'openai',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: '',
};

const MODELS = { data: [{ id: 'gemma4:26b' }, { id: 'llava:7b' }, { id: 'qwen3.5:9b' }] };

describe('tool-support marks are available', async () => {
  const calls = [];
  const { listModels } = load(async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/models')) return json(MODELS);
    const model = JSON.parse(opts.body).model;
    // llava can look, but it cannot call tools.
    return json({
      capabilities: model === 'llava:7b' ? ['completion', 'vision'] : ['completion', 'tools'],
    });
  });

  const models = await listModels(OLLAMA);

  it('the model without tools sank to the bottom', () => {
    assert.deepStrictEqual(
      models.map((m) => m.id),
      ['gemma4:26b', 'qwen3.5:9b', 'llava:7b'],
    );
  });

  it('the marks are set', () => {
    assert.deepStrictEqual(
      models.map((m) => m.tools),
      [true, true, false],
    );
  });

  it('the list and every model were asked for', () => {
    assert.deepStrictEqual(calls.length, 4);
  });
});

describe('another provider, no /api/show', async () => {
  const calls = [];
  const { listModels } = load(async (url) => {
    calls.push(url);
    if (url.endsWith('/models')) return json(MODELS);
    return json({ error: 'not found' }, 404);
  });

  const models = await listModels({
    ...OLLAMA,
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk_x',
  });

  it('the list comes back as given', () => {
    assert.deepStrictEqual(
      models.map((m) => m.id),
      ['gemma4:26b', 'llava:7b', 'qwen3.5:9b'],
    );
  });

  it('unannotated', () => {
    assert.deepStrictEqual(
      models.map((m) => m.tools),
      [null, null, null],
    );
  });

  it('/api/show is tried exactly once', () => {
    assert.deepStrictEqual(calls.filter((u) => u.includes('/api/show')).length, 1);
  });
});

describe('the server is not answering', async () => {
  const { listModels } = load(async () => {
    throw new Error('Failed to fetch');
  });
  const err = await listModels(OLLAMA).catch((e) => e.message);

  it('the address is in the error', () => {
    assert.match(err, /localhost:11434\/v1/);
  });
});

describe('the anthropic provider', async () => {
  const calls = [];
  const { listModels } = load(async (url) => {
    calls.push(url);
    return json(MODELS);
  });
  const models = await listModels({
    provider: 'anthropic',
    apiKey: 'sk-ant-real',
    baseUrl: 'https://api.groq.com/openai/v1',
  });

  it('there is no list to fetch', () => {
    assert.deepStrictEqual(models, []);
  });

  it('and the key went nowhere', () => {
    assert.deepStrictEqual(calls, []);
  });
});
