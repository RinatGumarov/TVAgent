/**
 * The worker's consent and permission gates, checked again before anything
 * reaches the network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/load.mjs';

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

  loadModule('background/service-worker.js', {
    chrome,
    fetch: fetchStub,
  }).registerWorker();

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

describe('permission relay', () => {
  it('a validated provider host reaches chrome.permissions, and the result returns', async () => {
    const worker = loadWorker({});
    const reply = await worker.message({
      type: 'provider-permission',
      action: 'request',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    assert.deepStrictEqual(worker.permissionCalls, [['request', 'https://api.groq.com/*']]);
    assert.deepStrictEqual(reply?.granted, true);
  });

  it('an unsafe provider never reaches chrome.permissions', async () => {
    const worker = loadWorker({});
    const reply = await worker.message({
      type: 'provider-permission',
      action: 'request',
      baseUrl: 'http://remote.example/v1',
    });
    assert.deepStrictEqual(worker.permissionCalls, []);
    assert.match(reply?.error || '', /HTTPS|localhost|127\.0\.0\.1/);
  });
});

describe('network privacy gate', () => {
  const configured = {
    provider: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    openaiApiKey: 'gsk-secret',
    openaiModel: 'model-a',
  };

  it('model listing is refused before affirmative consent', async () => {
    const worker = loadWorker(configured, { granted: ['https://api.groq.com/*'] });
    const reply = await worker.message({ type: 'list-models' });
    assert.match(reply?.error || '', /consent|disclosure/i);
    assert.deepStrictEqual(worker.fetchCalls, []);
  });

  it('model listing is refused when the optional grant is absent', async () => {
    const worker = loadWorker({ ...configured, dataDisclosureAccepted: true });
    const reply = await worker.message({ type: 'list-models' });
    assert.match(reply?.error || '', /access|permission/i);
    assert.deepStrictEqual(worker.fetchCalls, []);
  });

  it('a model turn is also refused before consent, and performs no fetch', async () => {
    const worker = loadWorker(configured, { granted: ['https://api.groq.com/*'] });
    const posts = await worker.run({ type: 'run', system: 's', messages: [], tools: [] });
    assert.ok(posts.some((p) => p.type === 'error' && /consent|disclosure/i.test(p.error)));
    assert.deepStrictEqual(worker.fetchCalls, []);
  });

  it('once both gates pass, the key goes to the configured endpoint and nowhere else', async () => {
    const worker = loadWorker(
      { ...configured, openaiModel: '', dataDisclosureAccepted: true },
      { granted: ['https://api.groq.com/*'] },
    );
    const reply = await worker.message({ type: 'list-models' });
    // Model discovery does not require a model to be selected already.
    assert.deepStrictEqual(reply, { models: [] });
    assert.deepStrictEqual(
      worker.fetchCalls.map((c) => c.url),
      ['https://api.groq.com/openai/v1/models'],
    );
    assert.deepStrictEqual(
      worker.fetchCalls[0]?.options?.headers?.authorization,
      'Bearer gsk-secret',
    );
  });
});
