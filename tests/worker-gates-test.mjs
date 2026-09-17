/**
 * The worker's consent and permission gates, checked again before anything
 * reaches the network.
 */
import { check, section, report } from './helpers/check.mjs';
import { readSource, loadShared } from './helpers/load.mjs';

const src = readSource('background/service-worker.js');
const shared = loadShared('shared/models.js', 'shared/credentials.js', 'shared/provider-url.js');

const json = (body, status = 200) => ({
  ok: status < 300,
  status,
  statusText: 'x',
  body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function loadWorker(data, { granted = [], grantRequests = true } = {}) {
  let messageListener = null;
  let connectListener = null;
  const permissionCalls = [];
  const fetchCalls = [];
  const origins = new Set(granted);
  const chrome = {
    action: { onClicked: { addListener() {} } },
    tabs: { sendMessage: () => Promise.resolve() },
    runtime: {
      onMessage: {
        addListener(fn) {
          messageListener = fn;
        },
      },
      onConnect: {
        addListener(fn) {
          connectListener = fn;
        },
      },
    },
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])),
      },
    },
    permissions: {
      contains: async ({ origins: asked }) => {
        permissionCalls.push(['contains', ...asked]);
        return asked.every((origin) => origins.has(origin));
      },
      request: async ({ origins: asked }) => {
        permissionCalls.push(['request', ...asked]);
        if (grantRequests) asked.forEach((origin) => origins.add(origin));
        return grantRequests;
      },
      remove: async ({ origins: asked }) => {
        permissionCalls.push(['remove', ...asked]);
        return asked.map((origin) => origins.delete(origin)).some(Boolean);
      },
    },
  };
  const fetchStub = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return json({ data: [] });
  };

  new Function(
    'chrome',
    'fetch',
    'importScripts',
    'TVAgentModels',
    'TVAgentCredentials',
    'TVAgentProviderURL',
    src,
  )(
    chrome,
    fetchStub,
    () => {},
    shared.TVAgentModels,
    shared.TVAgentCredentials,
    shared.TVAgentProviderURL,
  );

  async function message(msg) {
    return new Promise((resolve) => {
      const keepAlive = messageListener(msg, {}, resolve);
      if (keepAlive !== true) resolve(undefined);
    });
  }

  async function run(msg) {
    const posts = [];
    let onMessage = null;
    const port = {
      name: 'tvagent-llm',
      postMessage(value) {
        posts.push(value);
      },
      onDisconnect: { addListener() {} },
      onMessage: {
        addListener(fn) {
          onMessage = fn;
        },
      },
    };
    connectListener(port);
    await onMessage(msg);
    return posts;
  }

  return { message, run, permissionCalls, fetchCalls };
}

section('permission relay');

{
  const worker = loadWorker({});
  const reply = await worker.message({
    type: 'provider-permission',
    action: 'request',
    baseUrl: 'https://api.groq.com/openai/v1',
  });
  check('the worker requests only the validated provider host', worker.permissionCalls, [
    ['request', 'https://api.groq.com/*'],
  ]);
  check('the permission result returns to the panel', reply?.granted, true);
}

{
  const worker = loadWorker({});
  const reply = await worker.message({
    type: 'provider-permission',
    action: 'request',
    baseUrl: 'http://remote.example/v1',
  });
  check('an unsafe provider never reaches chrome.permissions', worker.permissionCalls, []);
  check(
    'the panel receives a useful URL error',
    /HTTPS|localhost|127\.0\.0\.1/.test(reply?.error || ''),
    true,
  );
}

section('network privacy gate');

const configured = {
  provider: 'openai',
  baseUrl: 'https://api.groq.com/openai/v1',
  openaiApiKey: 'gsk-secret',
  openaiModel: 'model-a',
};

{
  const worker = loadWorker(configured, { granted: ['https://api.groq.com/*'] });
  const reply = await worker.message({ type: 'list-models' });
  check(
    'model listing is refused before affirmative consent',
    /consent|disclosure/i.test(reply?.error || ''),
    true,
  );
  check('no key or request reaches the network before consent', worker.fetchCalls, []);
}

{
  const worker = loadWorker({ ...configured, dataDisclosureAccepted: true });
  const reply = await worker.message({ type: 'list-models' });
  check(
    'model listing is refused after the optional grant is absent',
    /access|permission/i.test(reply?.error || ''),
    true,
  );
  check('no key or request reaches an ungranted host', worker.fetchCalls, []);
}

{
  const worker = loadWorker(configured, { granted: ['https://api.groq.com/*'] });
  const posts = await worker.run({ type: 'run', system: 's', messages: [], tools: [] });
  check(
    'a model turn is also refused before consent',
    posts.some((p) => p.type === 'error' && /consent|disclosure/i.test(p.error)),
    true,
  );
  check('the turn performs no fetch before consent', worker.fetchCalls, []);
}

{
  const worker = loadWorker(
    { ...configured, openaiModel: '', dataDisclosureAccepted: true },
    { granted: ['https://api.groq.com/*'] },
  );
  const reply = await worker.message({ type: 'list-models' });
  check('model discovery does not require a model to be selected already', reply, { models: [] });
  check(
    'the request goes only to the configured model endpoint',
    worker.fetchCalls.map((c) => c.url),
    ['https://api.groq.com/openai/v1/models'],
  );
  check(
    'the provider key is attached only after both gates pass',
    worker.fetchCalls[0]?.options?.headers?.authorization,
    'Bearer gsk-secret',
  );
}

report();
