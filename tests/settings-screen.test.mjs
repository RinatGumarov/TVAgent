/** Runs the real panel-settings.js under the fake DOM and a fake chrome.storage. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, click, textOf } from './helpers/dom.mjs';
import { loadModule } from './helpers/load.mjs';

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
  const readKeys = [];
  const messages = [];
  const changeListeners = [];
  return {
    store,
    setCalls,
    readKeys,
    messages,
    /** What chrome.storage.onChanged would deliver after a write elsewhere. */
    fireChanged: (changes) => Promise.all(changeListeners.map((fn) => fn(changes, 'local'))),
    requestCalls,
    removeCalls,
    storage: {
      local: {
        get: async (keys) => {
          readKeys.push(...keys);
          return Object.fromEntries(
            keys.filter((k) => store[k] !== undefined).map((k) => [k, store[k]]),
          );
        },
        set: async (obj) => {
          setCalls.push({ ...obj });
          Object.assign(store, obj);
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    runtime: {
      sendMessage: async (msg) => {
        messages.push(msg);
        // The worker is the one that reads the key slots.
        if (msg?.type === 'key-status') {
          return { anthropic: !!store.apiKey, openai: !!store.openaiApiKey };
        }
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
  // The shared catalog and the credential rules come bundled into the screen.
  const Settings = loadModule('content/panel-settings.js', {
    window: win,
    document: doc,
    chrome: chr,
  });
  const Models = loadModule('shared/models.js', { window: win });
  return { Settings, Models, doc };
}

const groupsFor = (hostEl, provider) =>
  hostEl.querySelectorAll('[data-for]').filter((el) => el.dataset.for === provider);

const segByName = (hostEl, name) =>
  hostEl.querySelectorAll('.tva-seg').find((s) => s.dataset.seg === name);

const btnByValue = (seg, value) =>
  seg.querySelectorAll('button').find((b) => b.dataset.value === value);

const fireChange = (el) => (el.listeners.change || []).forEach((fn) => fn({ target: el }));

// ========================================================== data disclosure

describe('data disclosure and consent', () => {
  function consent(chr) {
    const doc = makeDocument();
    const Consent = loadModule('content/panel-consent.js', { document: doc, chrome: chr });
    const hostEl = doc.createElement('div');
    let agreed = 0;
    Consent.create(hostEl, { onAgree: () => agreed++ });
    return { hostEl, agreed: () => agreed };
  }

  it('the screen names what is sent, and to whom', () => {
    const copy = textOf(consent(makeChrome()).hostEl);
    assert.match(copy, /prompts and conversation/i);
    assert.match(copy, /chart context/i);
    assert.match(copy, /OHLCV/);
    assert.match(copy, /Pine source/i);
    assert.match(copy, /selected model provider/i);
    assert.match(copy, /API key is sent only to the selected model provider/i);
  });

  it('consent is stored only by the button, and then the panel is told', async () => {
    const chr = makeChrome();
    const { hostEl, agreed } = consent(chr);
    assert.deepStrictEqual(chr.setCalls, []);
    click(hostEl.querySelector('#tva-disclosure-agree'));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(chr.setCalls, [{ dataDisclosureAccepted: true }]);
    assert.deepStrictEqual(agreed(), 1);
  });

  it('configuration alone is not ready without consent', async () => {
    const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x' });
    const { Settings, doc } = load(chr);
    const api = Settings.create(doc.createElement('div'), { onChange: () => {} });
    assert.deepStrictEqual(await api.ready, false);
    api.setAccepted(true);
    assert.deepStrictEqual(api.isReady(), true);
  });

  it('settings keep one line for it, and Revoke takes the consent back', async () => {
    const chr = makeChrome({
      provider: 'anthropic',
      apiKey: 'sk-ant-x',
      dataDisclosureAccepted: true,
    });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    let revoked = 0;
    const api = Settings.create(hostEl, { onChange: () => {}, onRevoke: () => revoked++ });
    await api.ready;
    assert.deepStrictEqual(hostEl.querySelector('#tva-disclosure'), null);

    click(hostEl.querySelector('#tva-disclosure-revoke'));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(chr.store.dataDisclosureAccepted, false);
    assert.deepStrictEqual([api.accepted(), api.isReady(), revoked], [false, false, 1]);
  });
});

// ================================================================= API keys

describe('API keys stay off the page', () => {
  const stored = {
    provider: 'anthropic',
    apiKey: 'sk-ant-SECRET-abc',
    openaiApiKey: 'gsk-SECRET-xyz',
    dataDisclosureAccepted: true,
  };

  it('the screen has no key field and never reads a key slot', async () => {
    const chr = makeChrome(stored);
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;

    assert.deepStrictEqual(
      hostEl.querySelectorAll('input').filter((i) => i.attrs.type === 'password'),
      [],
    );
    assert.deepStrictEqual(
      chr.readKeys.filter((k) => /apikey/i.test(k)),
      [],
    );
    assert.doesNotMatch(textOf(hostEl), /SECRET/);
  });

  it('it shows whether the active provider has one', async () => {
    const chr = makeChrome({ ...stored, apiKey: '' });
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    assert.deepStrictEqual(await api.ready, false);
    assert.match(hostEl.querySelector('#tva-key-status').textContent, /^Not set/);

    // Saved on the options page, in another tab.
    chr.store.apiKey = 'sk-ant-new';
    await chr.fireChanged({ apiKey: { newValue: 'sk-ant-new' } });
    assert.deepStrictEqual(hostEl.querySelector('#tva-key-status').textContent, 'Set');
    assert.deepStrictEqual(api.isReady(), true);
  });

  it('Manage key asks the worker for the options page', async () => {
    const chr = makeChrome(stored);
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    await Settings.create(hostEl, { onChange: () => {} }).ready;
    click(hostEl.querySelector('#tva-key-manage'));
    assert.deepStrictEqual(chr.messages.at(-1), { type: 'open-options' });
  });
});

// =================================================== the segmented controls

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
      if (msg?.type !== 'list-models') return relay(msg);
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
      if (msg?.type !== 'list-models') return relay(msg);
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

describe('effort on an OpenAI-compatible provider', () => {
  it('has its own control and its own storage slot', async () => {
    const chr = makeChrome(
      { provider: 'openai', baseUrl: 'http://localhost:11434/v1', effort: 'xhigh' },
      { granted: ['http://localhost/*'] },
    );
    const { Settings, doc } = load(chr);
    const hostEl = doc.createElement('div');
    const api = Settings.create(hostEl, { onChange: () => {} });
    await api.ready;

    const seg = segByName(hostEl, 'openaiEffort');
    assert.deepStrictEqual(seg.closest('[data-for]').classList.contains('tva-hidden'), false);
    assert.deepStrictEqual(btnByValue(seg, 'auto').classList.contains('on'), true);

    click(btnByValue(seg, 'off'));
    assert.deepStrictEqual(chr.setCalls.at(-1), { openaiEffort: 'off' });
    assert.deepStrictEqual([chr.store.effort, api.current().effort], ['xhigh', 'off']);
  });
});

describe('the model picker', async () => {
  const chr = makeChrome(
    {
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      openaiModel: 'gemma4:26b',
      dataDisclosureAccepted: true,
    },
    { granted: ['http://localhost/*'] },
  );
  const relay = chr.runtime.sendMessage;
  chr.runtime.sendMessage = async (msg) =>
    msg?.type === 'list-models'
      ? {
          models: [
            { id: 'gemma4:26b', tools: true },
            { id: 'qwen3:8b', tools: true },
            { id: 'llama2:7b', tools: false },
          ],
        }
      : relay(msg);
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const api = Settings.create(hostEl, { onChange: () => {} });
  await api.ready;
  await api.refresh();

  const input = hostEl.querySelector('#tva-model2');
  const list = hostEl.querySelector('#tva-models');
  const fire = (type) => (input.listeners[type] || []).forEach((fn) => fn({ target: input }));
  const offered = () => list.querySelectorAll('.tva-combo-option').map((o) => o.dataset.value);

  it('focus offers every model, whatever is already in the field', () => {
    fire('focus');
    assert.deepStrictEqual(list.classList.contains('tva-hidden'), false);
    assert.deepStrictEqual(offered(), ['gemma4:26b', 'qwen3:8b', 'llama2:7b']);
    assert.match(textOf(list), /llama2:7b\s*no tool support/);
  });

  it('typing narrows the list', () => {
    input.value = 'QWEN';
    fire('input');
    assert.deepStrictEqual(offered(), ['qwen3:8b']);
  });

  it('a click picks the model, stores it and closes the list', () => {
    click(list.querySelector('.tva-combo-option'));
    assert.deepStrictEqual(input.value, 'qwen3:8b');
    assert.deepStrictEqual(chr.setCalls.at(-1), { openaiModel: 'qwen3:8b' });
    assert.deepStrictEqual(list.classList.contains('tva-hidden'), true);
  });
});
