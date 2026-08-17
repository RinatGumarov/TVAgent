/**
 * TVAgent — список моделей для выпадашки.
 *
 * Гоняет настоящий listModels() из service-worker.js с подставленным fetch:
 * разбор /v1/models, пометки tools через ollama-шный /api/show, порядок и
 * поведение, когда сервера нет. В конце — прогон против живой Ollama, если она
 * поднята.
 *
 *   node models-test.mjs
 */
import fs from 'node:fs';

const EXT = new URL('./extension/src/', import.meta.url).pathname;
const src = fs.readFileSync(`${EXT}background/service-worker.js`, 'utf8');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${name}${ok ? '' : `\n        получили ${JSON.stringify(got)}\n        ждали    ${JSON.stringify(want)}`}`);
}

const chromeStub = {
  action: { onClicked: { addListener() {} } },
  runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
  tabs: { sendMessage: () => Promise.resolve() },
  storage: { local: { get: async () => ({}) } },
};

const load = (fetchStub) =>
  new Function('chrome', 'fetch', `${src}\nreturn { listModels };`)(chromeStub, fetchStub);

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

console.log('\n— пометки tools есть —');
{
  const calls = [];
  const { listModels } = load(async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/models')) return json(MODELS);
    const model = JSON.parse(opts.body).model;
    // llava умеет смотреть, но не звать инструменты.
    return json({ capabilities: model === 'llava:7b' ? ['completion', 'vision'] : ['completion', 'tools'] });
  });

  const models = await listModels(OLLAMA);
  check('модель без tools ушла вниз', models.map((m) => m.id), ['gemma4:26b', 'qwen3.5:9b', 'llava:7b']);
  check('пометки проставлены', models.map((m) => m.tools), [true, true, false]);
  check('спросили и список, и каждую модель', calls.length, 4);
}

console.log('\n— чужой провайдер, /api/show нет —');
{
  const calls = [];
  const { listModels } = load(async (url) => {
    calls.push(url);
    if (url.endsWith('/models')) return json(MODELS);
    return json({ error: 'not found' }, 404);
  });

  const models = await listModels({ ...OLLAMA, baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x' });
  check('список отдан как есть', models.map((m) => m.id), ['gemma4:26b', 'llava:7b', 'qwen3.5:9b']);
  check('без пометок', models.map((m) => m.tools), [null, null, null]);
  check('пробуем /api/show ровно один раз', calls.filter((u) => u.includes('/api/show')).length, 1);
}

console.log('\n— сервер не отвечает —');
{
  const { listModels } = load(async () => { throw new Error('Failed to fetch'); });
  const err = await listModels(OLLAMA).catch((e) => e.message);
  check('в ошибке виден адрес', /localhost:11434\/v1/.test(err), true);
}

console.log('\n— провайдер anthropic —');
{
  const calls = [];
  const { listModels } = load(async (url) => { calls.push(url); return json(MODELS); });
  const models = await listModels({ provider: 'anthropic', apiKey: 'sk-ant-real', baseUrl: 'https://api.groq.com/openai/v1' });
  check('списка нет', models, []);
  check('и ключ никуда не ушёл', calls, []);
}

console.log('\n— живая Ollama —');
{
  const up = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);

  if (!up) {
    console.log(' skip  ollama не поднята');
  } else {
    const { listModels } = load(fetch);
    const models = await listModels(OLLAMA);
    check('модели пришли', models.length > 0, true);
    check('у всех проставлен tools', models.every((m) => typeof m.tools === 'boolean'), true);
    for (const m of models) console.log(`        ${m.tools ? '✓' : '·'} ${m.id}`);
  }
}

console.log(failed ? `\n ПРОВАЛЕНО: ${failed}\n` : '\n всё зелёное\n');
process.exit(failed ? 1 : 0);
