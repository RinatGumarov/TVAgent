/** Runs listModels() from service-worker.js against a stubbed fetch. */
import { check, section, report } from './helpers/check.mjs';
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

section('tool-support marks are available');
{
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
  check(
    'the model without tools sank to the bottom',
    models.map((m) => m.id),
    ['gemma4:26b', 'qwen3.5:9b', 'llava:7b'],
  );
  check(
    'the marks are set',
    models.map((m) => m.tools),
    [true, true, false],
  );
  check('the list and every model were asked for', calls.length, 4);
}

section('another provider, no /api/show');
{
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
  check(
    'the list comes back as given',
    models.map((m) => m.id),
    ['gemma4:26b', 'llava:7b', 'qwen3.5:9b'],
  );
  check(
    'unannotated',
    models.map((m) => m.tools),
    [null, null, null],
  );
  check('/api/show is tried exactly once', calls.filter((u) => u.includes('/api/show')).length, 1);
}

section('the server is not answering');
{
  const { listModels } = load(async () => {
    throw new Error('Failed to fetch');
  });
  const err = await listModels(OLLAMA).catch((e) => e.message);
  check('the address is in the error', /localhost:11434\/v1/.test(err), true);
}

section('the anthropic provider');
{
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
  check('there is no list to fetch', models, []);
  check('and the key went nowhere', calls, []);
}

report();
