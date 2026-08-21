/**
 * TVAgent — the settings screen.
 *
 * Runs the real panel-settings.js under the shared fake DOM and fake
 * chrome.storage / chrome.runtime. What is expensive to break:
 *
 *   - the API key fields being unreachable from the page. A content script's
 *     JavaScript is isolated; the nodes it appends are not, so the key used to
 *     be one `document.getElementById('tva-key').value` away from every script
 *     on tradingview.com. That is the reason those two fields are closed
 *     shadow roots and the reason this is the first thing checked here;
 *   - the migration off the shared key/model slot — the single reason a
 *     migrate() exists in this module. settings-test.mjs checks the same rules
 *     against the worker, so running them against *this* module is what keeps
 *     the two ends agreeing;
 *   - the segmented controls: one click writes exactly one field, repaints the
 *     `on` class on exactly one button, and calls onChange;
 *   - switching provider hides the other one's groups and writes neither its
 *     key nor its model — which is the bug the migration was written for;
 *   - ready, false/false/true by the readiness rules;
 *   - loadModels: one fetch per base URL, a fresh one when the URL changes,
 *     the latch released on failure, and a stale answer ignored.
 *
 * migrate() is private to the module's IIFE and is not exported. It is
 * exercised the only way it is ever called: `create(...).ready` really does
 * `get(KEYS).then(migrate).then(...)`, so this is the real function reached
 * through its one public path.
 *
 *   node settings-screen-test.mjs
 */
import { check, section, report } from './helpers/check.mjs';
import { makeDocument, click } from './helpers/dom.mjs';
import { readSource } from './helpers/load.mjs';

const src = readSource('content/panel-settings.js');

/**
 * get() returns only the keys actually in the store, like the real
 * chrome.storage.local — a missing key does not arrive as undefined, it does
 * not arrive at all. That is what the migration's `!== undefined` test rests
 * on, so a fake that answers with undefined would hide the whole question.
 */
function makeChrome(initial = {}) {
  const store = { ...initial };
  const setCalls = [];
  return {
    store,
    setCalls,
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
      sendMessage: async () => ({ models: [] }),
    },
  };
}

function load(chr) {
  const win = {};
  const doc = makeDocument();
  // The shared catalog and the credential rules load first, as the manifest
  // loads them.
  for (const rel of ['shared/models.js', 'shared/credentials.js']) {
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

// ======================================================= the key fields

section('the API key fields are out of the page’s reach');

{
  const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-secret', model: 'claude-opus-5' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  await Settings.create(hostEl, { onChange: () => {} }).ready;

  const host = hostEl.querySelector('#tva-key');
  check('the field is there', !!host, true);
  check('but its shadow root is closed', host.shadowRoot, null);
  check(
    'no input is reachable by walking the panel’s DOM',
    hostEl.querySelectorAll('input').filter((i) => i.attrs.type === 'password').length,
    0
  );
  check(
    'and the key is nowhere in the page tree',
    JSON.stringify(hostEl.querySelectorAll('input').map((i) => i.value)).includes('sk-ant-secret'),
    false
  );

  // Inside, where only the extension can look, the field is loaded normally.
  check('the key did reach the field itself', secretInput(hostEl, '#tva-key').value, 'sk-ant-secret');
  check('and it is a password field', secretInput(hostEl, '#tva-key').attrs.type, 'password');
}

{
  const chr = makeChrome({ provider: 'anthropic' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  await Settings.create(hostEl, { onChange: () => {} }).ready;

  const input = secretInput(hostEl, '#tva-key');
  input.value = '  sk-ant-typed  ';
  (input.listeners.change || []).forEach((fn) => fn({}));
  check('typing into it still writes storage, trimmed', chr.store.apiKey, 'sk-ant-typed');

  const other = secretInput(hostEl, '#tva-key2');
  other.value = 'openai-typed';
  (other.listeners.change || []).forEach((fn) => fn({}));
  check('and each field writes its own slot', chr.store.openaiApiKey, 'openai-typed');
}

// ========================================================= the migration

section('migrating off the shared slot');

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

  check('an sk-ant key stays on the Anthropic side', chr.store.apiKey, 'sk-ant-real');
  check('the openai key is left empty', chr.store.openaiApiKey, '');
  // The model is decided on its own evidence, not by which provider happens
  // to be selected. It used to be moved wholesale, so the first switch to a
  // local provider silently cleared the user's Anthropic model — and switching
  // back left them on the default.
  check('a claude model stays on the Anthropic side too', chr.store.model, 'claude-opus-5');
  check('and does not become the openai model', chr.store.openaiModel, '');
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

  check('an ordinary key moves to the OpenAI side', chr.store.openaiApiKey, 'ollama-ignores-this');
  check('and so does the model', chr.store.openaiModel, 'gemma4:26b-a4b-it-qat');
  check('the apiKey slot is cleared', chr.store.apiKey, '');
  check('the shared model slot is cleared', chr.store.model, '');
}

{
  const chr = makeChrome({
    provider: 'openai',
    apiKey: 'stale-shared-value',
    model: 'stale-model',
    openaiApiKey: 'real-openai-key',
    openaiModel: 'real-openai-model',
    baseUrl: 'http://localhost:11434/v1',
  });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  await Settings.create(hostEl, { onChange: () => {} }).ready;

  check('already-split storage is not touched at all', chr.setCalls.length, 0);
  check('openaiApiKey is unchanged', chr.store.openaiApiKey, 'real-openai-key');
  check('openaiModel is unchanged', chr.store.openaiModel, 'real-openai-model');
}

// =================================================== the segmented controls

section('the segmented controls');

{
  const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x', model: 'claude-sonnet-5', effort: 'high' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const changes = [];
  const api = Settings.create(hostEl, { onChange: (c) => changes.push(c) });
  await api.ready;

  chr.setCalls.length = 0;
  changes.length = 0;

  const effortSeg = segByName(hostEl, 'effort');
  click(btnByValue(effortSeg, 'medium'));

  check('a click writes only that field', chr.setCalls, [{ effort: 'medium' }]);
  const onButtons = effortSeg.querySelectorAll('button').filter((b) => b.classList.contains('on'));
  check('the on class is on exactly one button', onButtons.length, 1);
  check('the one that was clicked', onButtons[0]?.dataset.value, 'medium');
  check('onChange saw the new state', changes[changes.length - 1]?.effort, 'medium');
}

{
  // The model buttons are the shared catalog, not a list written out here.
  // They used to be spelled out in four places, which is how a model could be
  // offered that the worker could not actually call.
  const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x' });
  const { Settings, Models, doc } = load(chr);
  const hostEl = doc.createElement('div');
  await Settings.create(hostEl, { onChange: () => {} }).ready;

  const offered = segByName(hostEl, 'model').querySelectorAll('button').map((b) => b.dataset.value);
  check('every catalog model is offered', offered, Models.ANTHROPIC.map((m) => m.id));
}

// ==================================================== switching provider

section('switching provider hides the other one’s groups');

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

  check('before: the Anthropic groups are visible', groupsFor(hostEl, 'anthropic').every((g) => !g.classList.contains('tva-hidden')), true);
  check('before: the OpenAI groups are hidden', groupsFor(hostEl, 'openai').every((g) => g.classList.contains('tva-hidden')), true);

  chr.setCalls.length = 0;
  click(btnByValue(segByName(hostEl, 'provider'), 'openai'));
  await Promise.resolve(); // let the click handler's .then(loadModels) run

  check('after: the OpenAI groups are visible', groupsFor(hostEl, 'openai').every((g) => !g.classList.contains('tva-hidden')), true);
  check('after: the Anthropic groups are hidden', groupsFor(hostEl, 'anthropic').every((g) => g.classList.contains('tva-hidden')), true);

  // The bug the migration was written for: switching provider wrote the other
  // side's model and key. The only write a provider click may make is the
  // provider itself.
  check('switching writes nothing but the provider', chr.setCalls, [{ provider: 'openai' }]);
  check(
    'and the stored openai fields are untouched',
    [chr.store.openaiApiKey, chr.store.openaiModel],
    ['existing-openai-key', 'existing-openai-model']
  );
}

// ===================================================================== ready

section('ready');

{
  const chr = makeChrome({ provider: 'anthropic' });
  const { Settings, doc } = load(chr);
  const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
  check('anthropic with no key: ready = false', ready, false);
}

{
  const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x' });
  const { Settings, doc } = load(chr);
  const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
  check('anthropic with a key: ready = true', ready, true);
}

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', openaiApiKey: '', openaiModel: '' });
  const { Settings, doc } = load(chr);
  const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
  check('openai with no model: ready = false', ready, false);
}

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', openaiApiKey: '', openaiModel: 'gemma4:26b-a4b-it-qat' });
  const { Settings, doc } = load(chr);
  const ready = await Settings.create(doc.createElement('div'), { onChange: () => {} }).ready;
  check('openai with a model: ready = true', ready, true);
}

// ================================================================ loadModels

section('loadModels: once per URL, again when it changes');

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://host-a/v1', openaiApiKey: '', openaiModel: 'm' });
  let calls = 0;
  chr.runtime.sendMessage = async () => { calls++; return { models: [{ id: 'model-a', tools: true }] }; };
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const api = Settings.create(hostEl, { onChange: () => {} });
  await api.ready;

  await api.refresh();
  check('the first refresh makes one request', calls, 1);

  await api.refresh();
  check('a second refresh at the same URL does not ask again', calls, 1);

  hostEl.querySelector('#tva-base').value = 'http://host-b/v1';
  await api.refresh();
  check('changing the base URL asks again', calls, 2);
}

section('loadModels: a failure releases the latch');

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://host-err/v1', openaiApiKey: '', openaiModel: 'm' });
  let calls = 0;
  chr.runtime.sendMessage = async () => { calls++; throw new Error('boom'); };
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const api = Settings.create(hostEl, { onChange: () => {} });
  await api.ready;

  await api.refresh();
  check('the request was made', calls, 1);
  check('the hint says what went wrong', hostEl.querySelector('#tva-model-hint').textContent.includes('boom'), true);

  await api.refresh();
  check('and a later refresh asks again — the latch was released', calls, 2);
}

section('loadModels: a stale answer is ignored');

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://host-1/v1', openaiApiKey: '', openaiModel: 'm' });
  const pending = [];
  chr.runtime.sendMessage = () => new Promise((resolve) => pending.push(resolve));
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const api = Settings.create(hostEl, { onChange: () => {} });
  await api.ready;

  const baseEl = hostEl.querySelector('#tva-base');

  baseEl.value = 'http://host-1/v1';
  const p1 = api.refresh(); // the latch takes host-1; no answer yet

  baseEl.value = 'http://host-2/v1';
  const p2 = api.refresh(); // the URL changed, so the latch moves to host-2

  // The current request answers first, which is the order the latch exists
  // for: not "the late answer never came" but "it came after the current one
  // and must not overwrite it". Resolving the other way round would let the
  // current answer land last and mask a missing latch entirely.
  pending[1]({ models: [{ id: 'fresh' }] }); // the answer for host-2
  await p2;
  pending[0]({ models: [{ id: 'STALE' }] }); // host-1's late answer
  await p1;

  const ids = hostEl.querySelector('#tva-models').children.map((o) => o.value);
  check('only the current URL’s model is listed', ids, ['fresh']);
  check('the stale one did not leak in', ids.includes('STALE'), false);
}

report();
