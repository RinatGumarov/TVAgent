/** Runs the real panel-settings.js under the fake DOM and a fake chrome.storage. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, click, textOf } from './helpers/dom.mjs';
import { readSource } from './helpers/load.mjs';

const src = readSource('content/panel-settings.js');

/**
 * get() returns only the keys in the store, like the real
 * chrome.storage.local: a missing key does not arrive at all, which is what
 * the migration's `!== undefined` test rests on.
 */
function makeChrome(initial = {}, { granted = [], grantRequests = true } = {}) {
  const store = { ...initial };
  const setCalls = [];
  const requestCalls = [];
  const removeCalls = [];
  const origins = new Set(granted);
  return {
    store,
    setCalls,
    requestCalls,
    removeCalls,
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(keys.filter((k) => store[k] !== undefined).map((k) => [k, store[k]])),
        set: async (obj) => {
          setCalls.push({ ...obj });
          Object.assign(store, obj);
        },
      },
    },
    runtime: {
      sendMessage: async (msg) => {
        if (msg?.type !== 'provider-permission') return { models: [] };
        const url = new URL(msg.baseUrl);
        const permission = `${url.protocol}//${url.hostname}/*`;
        if (msg.action === 'contains') return { granted: origins.has(permission) };
        if (msg.action === 'request') {
          requestCalls.push([permission]);
          if (grantRequests) origins.add(permission);
          return { granted: grantRequests };
        }
        if (msg.action === 'remove') {
          removeCalls.push([permission]);
          return { removed: origins.delete(permission) };
        }
        return { error: 'unknown permission action' };
      },
    },
  };
}

function load(chr) {
  const win = {};
  const doc = makeDocument();
  // The shared catalog and the credential rules load first, as the manifest
  // loads them.
  for (const rel of ['shared/models.js', 'shared/credentials.js', 'shared/provider-url.js']) {
    new Function('globalThis', 'window', readSource(rel))(win, win);
  }
  new Function('window', 'document', 'chrome', src)(win, doc, chr);
  return { Settings: win.TVAgentSettings, Models: win.TVAgentModels, doc };
}

const groupsFor = (hostEl, provider) =>
  hostEl.querySelectorAll('[data-for]').filter((el) => el.dataset.for === provider);

const segByName = (hostEl, name) =>
  hostEl.querySelectorAll('.tva-seg').find((s) => s.dataset.seg === name);

const btnByValue = (seg, value) =>
  seg.querySelectorAll('button').find((b) => b.dataset.value === value);

/** The input inside a key field — reachable from the test, and nowhere else. */
const secretInput = (hostEl, id) =>
  hostEl.querySelector(id)._shadowRootForTests.querySelector('input');

const fireChange = (el) => (el.listeners.change || []).forEach((fn) => fn({ target: el }));

// ========================================================== data disclosure

describe('data disclosure and consent', async () => {
  {
    const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x' });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    const ready = await api.ready;

    const disclosure = hostEl.querySelector('#tva-disclosure');
    const copy = disclosure ? textOf(disclosure) : '';
    const got1 = !!disclosure;
    const want1 = true;
    it('the disclosure is visible in the product UI', () => {
      assert.deepStrictEqual(got1, want1);
    });
    const got2 = /prompt|conversation/i.test(copy);
    const want2 = true;
    it('it names prompts and conversations', () => {
      assert.deepStrictEqual(got2, want2);
    });
    const got3 = /chart context/i.test(copy) && /OHLCV/i.test(copy);
    const want3 = true;
    it('it names chart context and recent OHLCV bars', () => {
      assert.deepStrictEqual(got3, want3);
    });
    const got4 = /Pine source/i.test(copy);
    const want4 = true;
    it('it names Pine source', () => {
      assert.deepStrictEqual(got4, want4);
    });
    const got5 = /model provider/i.test(copy);
    const want5 = true;
    it('it says the selected model provider receives the data', () => {
      assert.deepStrictEqual(got5, want5);
    });
    const got6 = /API key[\s\S]*selected model provider/i.test(copy);
    const want6 = true;
    it('it says the selected provider receives the API key for authentication', () => {
      assert.deepStrictEqual(got6, want6);
    });
    const got7 = ready;
    const want7 = false;
    it('configuration alone is not ready without consent', () => {
      assert.deepStrictEqual(got7, want7);
    });

    const accept = hostEl.querySelector('#tva-disclosure-accept');
    const got8 = !!accept;
    const want8 = true;
    it('the disclosure has an affirmative consent control', () => {
      assert.deepStrictEqual(got8, want8);
    });
    if (accept) {
      accept.checked = true;
      fireChange(accept);
    }
    const got9 = chr.store.dataDisclosureAccepted;
    const want9 = true;
    it('affirmative consent is stored only after the checkbox changes', () => {
      assert.deepStrictEqual(got9, want9);
    });
    const got10 = api.isReady?.();
    const want10 = true;
    it('the settings become ready after consent', () => {
      assert.deepStrictEqual(got10, want10);
    });
  }

  // ======================================================= the key fields
});

describe('the API key fields are out of the page’s reach', async () => {
  {
    const chr = makeChrome({
      provider: 'anthropic',
      apiKey: 'sk-ant-secret',
      model: 'claude-opus-5',
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;

    const host = hostEl.querySelector('#tva-key');
    const got11 = !!host;
    const want11 = true;
    it('the field is there', () => {
      assert.deepStrictEqual(got11, want11);
    });
    const got12 = host.shadowRoot;
    const want12 = null;
    it('but its shadow root is closed', () => {
      assert.deepStrictEqual(got12, want12);
    });
    const got13 = hostEl
      .querySelectorAll('input')
      .filter((i) => i.attrs.type === 'password').length;
    const want13 = 0;
    it('no input is reachable by walking the panel’s DOM', () => {
      assert.deepStrictEqual(got13, want13);
    });
    const got14 = JSON.stringify(hostEl.querySelectorAll('input').map((i) => i.value)).includes(
      'sk-ant-secret',
    );
    const want14 = false;
    it('and the key is nowhere in the page tree', () => {
      assert.deepStrictEqual(got14, want14);
    });

    // Inside, where only the extension can look, the field is loaded normally.
    const got15 = secretInput(hostEl, '#tva-key').value;
    const want15 = 'sk-ant-secret';
    it('the key did reach the field itself', () => {
      assert.deepStrictEqual(got15, want15);
    });
    const got16 = secretInput(hostEl, '#tva-key').attrs.type;
    const want16 = 'password';
    it('and it is a password field', () => {
      assert.deepStrictEqual(got16, want16);
    });
  }

  {
    const chr = makeChrome({ provider: 'anthropic' });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;

    const input = secretInput(hostEl, '#tva-key');
    input.value = '  sk-ant-typed  ';
    fireChange(input);
    const got17 = chr.store.apiKey;
    const want17 = 'sk-ant-typed';
    it('typing into it still writes storage, trimmed', () => {
      assert.deepStrictEqual(got17, want17);
    });

    const other = secretInput(hostEl, '#tva-key2');
    other.value = 'openai-typed';
    fireChange(other);
    const got18 = chr.store.openaiApiKey;
    const want18 = 'openai-typed';
    it('and each field writes its own slot', () => {
      assert.deepStrictEqual(got18, want18);
    });
  }

  // ========================================================= the migration
});

describe('migrating off the shared slot', async () => {
  {
    const chr = makeChrome({
      provider: 'openai',
      apiKey: 'sk-ant-real',
      model: 'claude-opus-5',
      baseUrl: 'http://localhost:11434/v1',
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;

    const got19 = chr.store.apiKey;
    const want19 = 'sk-ant-real';
    it('an sk-ant key stays on the Anthropic side', () => {
      assert.deepStrictEqual(got19, want19);
    });
    const got20 = chr.store.openaiApiKey;
    const want20 = '';
    it('the openai key is left empty', () => {
      assert.deepStrictEqual(got20, want20);
    });
    // The model is decided on its own evidence, not by which provider is
    // selected.
    const got21 = chr.store.model;
    const want21 = 'claude-opus-5';
    it('a claude model stays on the Anthropic side too', () => {
      assert.deepStrictEqual(got21, want21);
    });
    const got22 = chr.store.openaiModel;
    const want22 = '';
    it('and does not become the openai model', () => {
      assert.deepStrictEqual(got22, want22);
    });
  }

  {
    const chr = makeChrome({
      provider: 'openai',
      apiKey: 'ollama-ignores-this',
      model: 'gemma4:26b-a4b-it-qat',
      baseUrl: 'http://localhost:11434/v1',
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;

    const got23 = chr.store.openaiApiKey;
    const want23 = 'ollama-ignores-this';
    it('an ordinary key moves to the OpenAI side', () => {
      assert.deepStrictEqual(got23, want23);
    });
    const got24 = chr.store.openaiModel;
    const want24 = 'gemma4:26b-a4b-it-qat';
    it('and so does the model', () => {
      assert.deepStrictEqual(got24, want24);
    });
    const got25 = chr.store.apiKey;
    const want25 = '';
    it('the apiKey slot is cleared', () => {
      assert.deepStrictEqual(got25, want25);
    });
    const got26 = chr.store.model;
    const want26 = '';
    it('the shared model slot is cleared', () => {
      assert.deepStrictEqual(got26, want26);
    });
  }

  // =================================================== the segmented controls
});

describe('the segmented controls', async () => {
  {
    const chr = makeChrome({
      provider: 'anthropic',
      apiKey: 'sk-ant-x',
      model: 'claude-sonnet-5',
      effort: 'high',
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const changes = [];
    const api = Settings.create(hostEl, { onChange: (c) => changes.push(c) });
    await api.ready;

    chr.setCalls.length = 0;
    changes.length = 0;

    const effortSeg = segByName(hostEl, 'effort');
    click(btnByValue(effortSeg, 'medium'));

    const got27 = chr.setCalls;
    const want27 = [{ effort: 'medium' }];
    it('a click writes only that field', () => {
      assert.deepStrictEqual(got27, want27);
    });
    const onButtons = effortSeg
      .querySelectorAll('button')
      .filter((b) => b.classList.contains('on'));
    const got28 = onButtons.length;
    const want28 = 1;
    it('the on class is on exactly one button', () => {
      assert.deepStrictEqual(got28, want28);
    });
    const got29 = onButtons[0]?.dataset.value;
    const want29 = 'medium';
    it('the one that was clicked', () => {
      assert.deepStrictEqual(got29, want29);
    });
    const got30 = changes[changes.length - 1]?.effort;
    const want30 = 'medium';
    it('onChange saw the new state', () => {
      assert.deepStrictEqual(got30, want30);
    });
  }

  {
    // The model buttons come from the shared catalog.
    const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x' });
    const { Settings, Models, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;

    const offered = segByName(hostEl, 'model')
      .querySelectorAll('button')
      .map((b) => b.dataset.value);
    const got31 = offered;
    const want31 = Models.ANTHROPIC.map((m) => m.id);
    it('every catalog model is offered', () => {
      assert.deepStrictEqual(got31, want31);
    });
  }

  // ==================================================== switching provider
});

describe('switching provider hides the other one’s groups', async () => {
  {
    const chr = makeChrome({
      provider: 'anthropic',
      apiKey: 'sk-ant-x',
      model: 'claude-sonnet-5',
      effort: 'high',
      openaiApiKey: 'existing-openai-key',
      openaiModel: 'existing-openai-model',
      baseUrl: 'http://localhost:11434/v1',
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    await api.ready;

    const got32 = groupsFor(hostEl, 'anthropic').every((g) => !g.classList.contains('tva-hidden'));
    const want32 = true;
    it('before: the Anthropic groups are visible', () => {
      assert.deepStrictEqual(got32, want32);
    });
    const got33 = groupsFor(hostEl, 'openai').every((g) => g.classList.contains('tva-hidden'));
    const want33 = true;
    it('before: the OpenAI groups are hidden', () => {
      assert.deepStrictEqual(got33, want33);
    });

    chr.setCalls.length = 0;
    click(btnByValue(segByName(hostEl, 'provider'), 'openai'));
    await Promise.resolve(); // let the click handler's .then(loadModels) run

    const got34 = groupsFor(hostEl, 'openai').every((g) => !g.classList.contains('tva-hidden'));
    const want34 = true;
    it('after: the OpenAI groups are visible', () => {
      assert.deepStrictEqual(got34, want34);
    });
    const got35 = groupsFor(hostEl, 'anthropic').every((g) => g.classList.contains('tva-hidden'));
    const want35 = true;
    it('after: the Anthropic groups are hidden', () => {
      assert.deepStrictEqual(got35, want35);
    });

    // The only write a provider click may make is the provider itself.
    const got36 = chr.setCalls;
    const want36 = [{ provider: 'openai' }];
    it('switching writes nothing but the provider', () => {
      assert.deepStrictEqual(got36, want36);
    });
    const got37 = [chr.store.openaiApiKey, chr.store.openaiModel];
    const want37 = ['existing-openai-key', 'existing-openai-model'];
    it('and the stored openai fields are untouched', () => {
      assert.deepStrictEqual(got37, want37);
    });
  }

  // ===================================================================== ready
});

describe('ready', async () => {
  {
    const chr = makeChrome({ provider: 'anthropic' });
    const { Settings, doc } = load(chr);
    const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
    const got38 = ready;
    const want38 = false;
    it('anthropic with no key: ready = false', () => {
      assert.deepStrictEqual(got38, want38);
    });
  }

  {
    const chr = makeChrome({
      provider: 'anthropic',
      apiKey: 'sk-ant-x',
      dataDisclosureAccepted: true,
    });
    const { Settings, doc } = load(chr);
    const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
    const got39 = ready;
    const want39 = true;
    it('anthropic with a key: ready = true', () => {
      assert.deepStrictEqual(got39, want39);
    });
  }

  {
    const chr = makeChrome(
      {
        provider: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        openaiApiKey: '',
        openaiModel: '',
        dataDisclosureAccepted: true,
      },
      { granted: ['http://localhost/*'] },
    );
    const { Settings, doc } = load(chr);
    const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
    const got40 = ready;
    const want40 = false;
    it('openai with no model: ready = false', () => {
      assert.deepStrictEqual(got40, want40);
    });
  }

  {
    const chr = makeChrome(
      {
        provider: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        openaiApiKey: '',
        openaiModel: 'gemma4:26b-a4b-it-qat',
        dataDisclosureAccepted: true,
      },
      { granted: ['http://localhost/*'] },
    );
    const { Settings, doc } = load(chr);
    const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
    const got41 = ready;
    const want41 = true;
    it('openai with a model: ready = true', () => {
      assert.deepStrictEqual(got41, want41);
    });
  }

  {
    const chr = makeChrome({
      provider: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      openaiModel: 'model-a',
      dataDisclosureAccepted: true,
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    const ready = await api.ready;
    const got42 = ready;
    const want42 = false;
    it('a configured hosted provider is not ready before its host is granted', () => {
      assert.deepStrictEqual(got42, want42);
    });

    fireChange(hostEl.querySelector('#tva-base'));
    await Promise.resolve();
    await Promise.resolve();
    const got43 = structuredClone(chr.requestCalls);
    const want43 = [];
    it('editing the URL does not request permission outside an explicit button gesture', () => {
      assert.deepStrictEqual(got43, want43);
    });

    click(hostEl.querySelector('#tva-provider-access'));
    await Promise.resolve();
    await Promise.resolve();
    const got44 = chr.requestCalls;
    const want44 = [['https://api.groq.com/*']];
    it('the access button requests only the configured provider host', () => {
      assert.deepStrictEqual(got44, want44);
    });
    const got45 = api.isReady?.();
    const want45 = true;
    it('granting the provider host makes the settings ready', () => {
      assert.deepStrictEqual(got45, want45);
    });

    const base = hostEl.querySelector('#tva-base');
    base.value = 'https://api.groq.com/v2';
    fireChange(base);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const got46 = structuredClone(chr.removeCalls);
    const want46 = [];
    it('changing only the API path keeps the existing host grant', () => {
      assert.deepStrictEqual(got46, want46);
    });
    const got47 = api.isReady?.();
    const want47 = true;
    it('the same granted host remains ready after a path change', () => {
      assert.deepStrictEqual(got47, want47);
    });

    base.value = 'https://api.example.com/v1';
    fireChange(base);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const got48 = chr.removeCalls;
    const want48 = [['https://api.groq.com/*']];
    it('changing provider revokes the obsolete optional host', () => {
      assert.deepStrictEqual(got48, want48);
    });
    const got49 = api.isReady?.();
    const want49 = false;
    it('the new provider needs its own explicit grant', () => {
      assert.deepStrictEqual(got49, want49);
    });
  }

  // ================================================================ loadModels
});

describe('loadModels: once per URL, again when it changes', async () => {
  {
    const chr = makeChrome(
      {
        provider: 'openai',
        baseUrl: 'https://host-a.example/v1',
        openaiApiKey: '',
        openaiModel: 'm',
        dataDisclosureAccepted: true,
      },
      { granted: ['https://host-a.example/*', 'https://host-b.example/*'] },
    );
    let calls = 0;
    const relay = chr.runtime.sendMessage;
    chr.runtime.sendMessage = async (msg) => {
      if (msg?.type === 'provider-permission') return relay(msg);
      calls++;
      return { models: [{ id: 'model-a', tools: true }] };
    };
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    await api.ready;

    await api.refresh();
    const got50 = calls;
    const want50 = 1;
    it('the first refresh makes one request', () => {
      assert.deepStrictEqual(got50, want50);
    });

    await api.refresh();
    const got51 = calls;
    const want51 = 1;
    it('a second refresh at the same URL does not ask again', () => {
      assert.deepStrictEqual(got51, want51);
    });

    hostEl.querySelector('#tva-base').value = 'https://host-b.example/v1';
    await api.refresh();
    const got52 = calls;
    const want52 = 2;
    it('changing the base URL asks again', () => {
      assert.deepStrictEqual(got52, want52);
    });
  }
});

describe('loadModels: a failure releases the latch', async () => {
  {
    const chr = makeChrome(
      {
        provider: 'openai',
        baseUrl: 'https://host-err.example/v1',
        openaiApiKey: '',
        openaiModel: 'm',
        dataDisclosureAccepted: true,
      },
      { granted: ['https://host-err.example/*'] },
    );
    let calls = 0;
    const relay = chr.runtime.sendMessage;
    chr.runtime.sendMessage = async (msg) => {
      if (msg?.type === 'provider-permission') return relay(msg);
      calls++;
      throw new Error('boom');
    };
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    await api.ready;

    await api.refresh();
    const got53 = calls;
    const want53 = 1;
    it('the request was made', () => {
      assert.deepStrictEqual(got53, want53);
    });
    const got54 = hostEl.querySelector('#tva-model-hint').textContent.includes('boom');
    const want54 = true;
    it('the hint says what went wrong', () => {
      assert.deepStrictEqual(got54, want54);
    });

    await api.refresh();
    const got55 = calls;
    const want55 = 2;
    it('and a later refresh asks again — the latch was released', () => {
      assert.deepStrictEqual(got55, want55);
    });
  }
});
