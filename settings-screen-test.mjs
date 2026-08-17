/**
 * TVAgent — экран настроек.
 *
 * Гоняет настоящий panel-settings.js под самодельным DOM и поддельными
 * chrome.storage / chrome.runtime. Проверяет то, что дорого сломать:
 *
 *   - миграцию общего слота ключ/модель — она тут единственная причина,
 *     почему этот модуль вообще существует, и settings-test.mjs проверяет
 *     ту же логику отдельно против service-worker.js, так что здесь она
 *     гоняется против *этого* модуля, чтобы оба остались согласованы;
 *   - сегментированные переключатели — клик пишет ровно одно поле,
 *     перекрашивает класс on ровно на одну кнопку и зовёт onChange;
 *   - переключение провайдера прячет чужие группы и не пишет чужой
 *     ключ/модель — ровно тот баг, что чинила миграция;
 *   - ready — false/false/true по правилам готовности;
 *   - loadModels — фетч раз на baseUrl, повтор при смене URL, снятие
 *     защёлки при ошибке и игнор устаревшего ответа.
 *
 * migrate() внутри panel-settings.js — приватная функция замыкания IIFE,
 * наружу не экспортирована (в отличие от settings() в service-worker.js,
 * который settings-test.mjs достаёт через `return { settings }`). Чтобы не
 * трогать сам модуль (в задаче явно запрещено — код берётся из плана
 * дословно), миграция здесь проверяется не переопределением, а тем, что
 * `create(...).ready` в реальности делает `get(KEYS).then(migrate).then(...)`
 * — то есть тестируется настоящая migrate(), просто через единственный
 * публичный путь, которым она вызывается.
 *
 * Что подделка DOM моделирует по-настоящему:
 *   - innerHTML-парсинг вложенных тегов с атрибутами (id, class, data-*,
 *     type, list, for, autocomplete, spellcheck), включая ту часть, которой
 *     нет у chat-test.mjs: <input> в шаблоне этого модуля никогда не
 *     закрывается тегом </input>, так что парсер обязан знать про
 *     void-элементы и не запихивать в них следующих соседей;
 *   - id/dataset/className, вычисленные из атрибутов в момент разбора —
 *     ровно то, что модуль читает (dataset.seg/value/for, id для query),
 *     и он никогда не meняет их через setAttribute после создания, так что
 *     разовое вычисление, а не живой пересчёт, ничего не прячет;
 *   - classList.add/remove/contains/toggle(force), вычисляемый по текущему
 *     className, а не по отдельному Set (тот же принцип, что в chat-test.mjs);
 *   - querySelector/querySelectorAll/closest по #id, .class, тегу, [attr] и
 *     их простым сочетаниям (например button[data-value]) — ровно тот
 *     набор, что реально встречается в исходнике;
 *   - click(el) — настоящее всплытие: обходит el и его предков и зовёт
 *     'click'-слушатели каждого уровня с {target: el}, потому что сегменты
 *     вешают один делегирующий слушатель на контейнер, а не на кнопки;
 *   - chrome.storage.local.get(keys) отдаёт только реально лежащие в
 *     хранилище ключи (как настоящий chrome.storage.local — отсутствующий
 *     ключ не приходит как undefined, а не приходит вовсе), что важно для
 *     migrate()'овской проверки `!== undefined`;
 *   - chrome.storage.local.set(obj) синхронно (в теле async-функции без
 *     await) применяет изменения к стору, так что assert можно делать сразу
 *     после вызова, не дожидаясь микротаска — но `.then(loadModels)` в
 *     обработчике клика по provider всё равно остаётся асинхронным шагом, и
 *     тесты, которым это важно, явно ждут `await Promise.resolve()`;
 *   - chrome.runtime.sendMessage управляется тестом вручную (в том числе
 *     через отложенные resolve) — иначе гонку "устаревший ответ" было бы
 *     нечем воспроизвести детерминированно.
 *
 * Что НЕ моделирует:
 *   - селекторы с потомочной цепочкой ("a b") или значением атрибута
 *     ("[data-for=openai]") — модуль их не использует, тесты вместо этого
 *     достают группы через querySelectorAll('[data-for]') и фильтр по
 *     .dataset.for;
 *   - innerHTML на чтение (геттер — заглушка) — модуль его не читает;
 *   - живую синхронизацию dataset/id при setAttribute — модуль его не
 *     зовёт на уже созданных элементах.
 *
 *   node settings-screen-test.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('./extension/src/content/panel-settings.js', import.meta.url).pathname,
  'utf8'
);

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? ' ok  ' : ' FAIL'} ${name}` +
      (ok ? '' : `\n        получили ${JSON.stringify(got)}\n        ждали    ${JSON.stringify(want)}`)
  );
}

// ------------------------------------------------------------------ DOM

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

function descendants(node) {
  const out = [];
  for (const c of node.children) {
    out.push(c);
    if (c.nodeType === 'element') out.push(...descendants(c));
  }
  return out;
}

function textOf(node) {
  if (node.nodeType === 'text') return node.text;
  return node.children.map(textOf).join('');
}

function computeDataset(el) {
  el.dataset = {};
  for (const [k, v] of Object.entries(el.attrs)) {
    if (!k.startsWith('data-')) continue;
    const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    el.dataset[camel] = v;
  }
}

/** Одно составное звено селектора: тег?, #id?, .class*, [attr]* — без пробелов. */
function matchesSel(node, sel) {
  if (!node || node.nodeType !== 'element') return false;
  let rest = sel;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagM) {
    if (node.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  const idM = rest.match(/#([\w-]+)/);
  if (idM && node.id !== idM[1]) return false;
  for (const c of rest.match(/\.[\w-]+/g) || []) {
    if (!(node.className || '').split(/\s+/).filter(Boolean).includes(c.slice(1))) return false;
  }
  for (const a of rest.match(/\[[\w-]+\]/g) || []) {
    if (!(a.slice(1, -1) in node.attrs)) return false;
  }
  return true;
}

function makeClassList(el) {
  const parts = () => (el.className || '').split(/\s+/).filter(Boolean);
  const write = (set) => (el.className = [...set].join(' '));
  return {
    contains: (c) => parts().includes(c),
    add: (...cs) => { const s = new Set(parts()); cs.forEach((c) => s.add(c)); write(s); },
    remove: (...cs) => { const s = new Set(parts()); cs.forEach((c) => s.delete(c)); write(s); },
    toggle: (c, force) => {
      const has = parts().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want !== has) {
        const s = new Set(parts());
        want ? s.add(c) : s.delete(c);
        write(s);
      }
      return want;
    },
  };
}

function parseFragment(html) {
  const root = { children: [] };
  const stack = [root];
  const tagRe = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*)?>/g;
  let last = 0;
  let m;

  const pushText = (raw) => {
    if (raw === '') return;
    const container = stack[stack.length - 1];
    container.children.push({ nodeType: 'text', text: raw, parent: container === root ? null : container });
  };

  while ((m = tagRe.exec(html))) {
    if (m.index > last) pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    const tok = m[0];

    if (tok.startsWith('</')) {
      const tagName = tok.slice(2, -1).trim().toUpperCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === tagName) { stack.length = i; break; }
      }
      continue;
    }

    const mm = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)>$/.exec(tok);
    const tagName = mm[1];
    const el = makeElement(tagName);
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(mm[2] || ''))) {
      if (am[1] === 'class') el.className = am[2] || '';
      else el.attrs[am[1]] = am[2] === undefined ? '' : am[2];
    }
    computeDataset(el);
    if (el.attrs.id) el.id = el.attrs.id;

    const container = stack[stack.length - 1];
    el.parent = container === root ? null : container;
    container.children.push(el);

    if (!VOID_TAGS.has(tagName.toLowerCase())) stack.push(el);
  }
  if (last < html.length) pushText(html.slice(last));

  return root.children;
}

function makeElement(tagName) {
  const el = {
    nodeType: 'element',
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    attrs: {},
    dataset: {},
    children: [],
    parent: null,
    listeners: {},
    value: '',
    checked: false,

    appendChild(child) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child);
        if (i !== -1) child.parent.children.splice(i, 1);
      }
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parent) {
        const i = el.parent.children.indexOf(el);
        if (i !== -1) el.parent.children.splice(i, 1);
      }
      el.parent = null;
    },
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    querySelector(sel) {
      return descendants(el).find((n) => matchesSel(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return descendants(el).filter((n) => matchesSel(n, sel));
    },
    closest(sel) {
      let n = el;
      while (n && n.nodeType === 'element') {
        if (matchesSel(n, sel)) return n;
        n = n.parent;
      }
      return null;
    },
  };

  Object.defineProperty(el, 'innerHTML', {
    set(html) {
      el.children = parseFragment(html);
      el.children.forEach((n) => (n.parent = el));
    },
    get() { return '[fake: write-only]'; },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return textOf(el); },
    set(v) { el.children = [{ nodeType: 'text', text: String(v), parent: el }]; },
  });
  Object.defineProperty(el, 'classList', { get: () => makeClassList(el) });

  return el;
}

function makeDocument() {
  return { createElement: (tag) => makeElement(tag) };
}

/** Настоящее всплытие: слушатели el и всех его предков, в этом порядке. */
function click(el) {
  const evt = { target: el };
  let n = el;
  while (n) {
    (n.listeners.click || []).forEach((fn) => fn(evt));
    n = n.parent;
  }
}

// -------------------------------------------------------------- chrome

/**
 * get() отдаёт только реально лежащие в data ключи (как настоящий
 * chrome.storage.local) — это то, на чём держится проверка
 * `s.openaiApiKey !== undefined` внутри migrate().
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
  new Function('window', 'document', 'chrome', src)(win, doc, chr);
  return { Settings: win.TVAgentSettings, doc };
}

function groupsFor(hostEl, provider) {
  return hostEl.querySelectorAll('[data-for]').filter((el) => el.dataset.for === provider);
}

function segByName(hostEl, name) {
  return hostEl.querySelectorAll('.tva-seg').find((s) => s.dataset.seg === name);
}

function btnByValue(seg, value) {
  return seg.querySelectorAll('button').find((b) => b.dataset.value === value);
}

// ============================================================= миграция

console.log('\n— миграция общего слота —');

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

  check('sk-ant-ключ уехал на сторону Anthropic', chr.store.apiKey, 'sk-ant-real');
  check('openai-ключ остался пустым', chr.store.openaiApiKey, '');
  check('модель ушла в openaiModel', chr.store.openaiModel, 'claude-opus-5');
  check('общий слот model очищен', chr.store.model, '');
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

  check('обычный ключ уехал на сторону OpenAI', chr.store.openaiApiKey, 'ollama-ignores-this');
  check('модель ушла в openaiModel', chr.store.openaiModel, 'gemma4:26b-a4b-it-qat');
  check('слот apiKey очищен', chr.store.apiKey, '');
  check('общий слот model очищен', chr.store.model, '');
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

  check('уже разделённое хранилище миграция не трогает (ни одной записи)', chr.setCalls.length, 0);
  check('openaiApiKey не изменился', chr.store.openaiApiKey, 'real-openai-key');
  check('openaiModel не изменился', chr.store.openaiModel, 'real-openai-model');
}

// ======================================================= сегментированные

console.log('\n— сегментированные переключатели —');

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
  const mediumBtn = btnByValue(effortSeg, 'medium');
  click(mediumBtn);

  check('клик по сегменту пишет только это поле', chr.setCalls, [{ effort: 'medium' }]);
  const onButtons = effortSeg.querySelectorAll('button').filter((b) => b.classList.contains('on'));
  check('класс on стоит ровно на одной кнопке', onButtons.length, 1);
  check('это выбранная кнопка', onButtons[0]?.dataset.value, 'medium');
  check('onChange получил новое состояние', changes[changes.length - 1]?.effort, 'medium');
}

// ============================================ переключение провайдера

console.log('\n— переключение провайдера прячет чужие группы —');

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

  check('до переключения группы Anthropic видны', groupsFor(hostEl, 'anthropic').every((g) => !g.classList.contains('tva-hidden')), true);
  check('до переключения группы OpenAI скрыты', groupsFor(hostEl, 'openai').every((g) => g.classList.contains('tva-hidden')), true);

  chr.setCalls.length = 0;
  const providerSeg = segByName(hostEl, 'provider');
  click(btnByValue(providerSeg, 'openai'));
  await Promise.resolve(); // даём отработать .then(loadModels) из обработчика клика

  check('после переключения группы OpenAI видны', groupsFor(hostEl, 'openai').every((g) => !g.classList.contains('tva-hidden')), true);
  check('после переключения группы Anthropic скрыты', groupsFor(hostEl, 'anthropic').every((g) => g.classList.contains('tva-hidden')), true);

  // Баг, который чинила миграция: переключение провайдера писало
  // модель/ключ чужой стороны. Единственная запись при клике по сегменту
  // provider обязана быть самим provider — ничего больше.
  check('переключение провайдера не пишет чужие apiKey/model/openaiApiKey/openaiModel', chr.setCalls, [{ provider: 'openai' }]);
  check(
    'значения openai-полей в хранилище не тронуты переключением',
    [chr.store.openaiApiKey, chr.store.openaiModel],
    ['existing-openai-key', 'existing-openai-model']
  );
}

// ===================================================================== ready

console.log('\n— ready —');

{
  const chr = makeChrome({ provider: 'anthropic' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const ready = await Settings.create(hostEl, { onChange: () => {} }).ready;
  check('anthropic без ключа: ready = false', ready, false);
}

{
  const chr = makeChrome({ provider: 'anthropic', apiKey: 'sk-ant-x' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const ready = await Settings.create(hostEl, { onChange: () => {} }).ready;
  check('anthropic с ключом: ready = true', ready, true);
}

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', openaiApiKey: '', openaiModel: '' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const ready = await Settings.create(hostEl, { onChange: () => {} }).ready;
  check('openai без модели: ready = false', ready, false);
}

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', openaiApiKey: '', openaiModel: 'gemma4:26b-a4b-it-qat' });
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const ready = await Settings.create(hostEl, { onChange: () => {} }).ready;
  check('openai с моделью: ready = true', ready, true);
}

// ================================================================ loadModels

console.log('\n— loadModels: раз на URL, повтор при смене —');

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://host-a/v1', openaiApiKey: '', openaiModel: 'm' });
  let calls = 0;
  chr.runtime.sendMessage = async () => { calls++; return { models: [{ id: 'model-a', tools: true }] }; };
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const api = Settings.create(hostEl, { onChange: () => {} });
  await api.ready;

  await api.refresh();
  check('первый refresh делает один запрос', calls, 1);

  await api.refresh();
  check('повторный refresh с тем же URL не переспрашивает', calls, 1);

  hostEl.querySelector('#tva-base').value = 'http://host-b/v1';
  await api.refresh();
  check('смена base URL вызывает повторный запрос', calls, 2);
}

console.log('\n— loadModels: ошибка снимает защёлку —');

{
  const chr = makeChrome({ provider: 'openai', baseUrl: 'http://host-err/v1', openaiApiKey: '', openaiModel: 'm' });
  let calls = 0;
  chr.runtime.sendMessage = async () => { calls++; throw new Error('boom'); };
  const { Settings, doc } = load(chr);
  const hostEl = doc.createElement('div');
  const api = Settings.create(hostEl, { onChange: () => {} });
  await api.ready;

  await api.refresh();
  check('запрос сделан', calls, 1);
  check('подсказка сообщает об ошибке', hostEl.querySelector('#tva-model-hint').textContent.includes('boom'), true);

  await api.refresh();
  check('после ошибки повторный refresh снова спрашивает — защёлка снята', calls, 2);
}

console.log('\n— loadModels: устаревший ответ игнорируется —');

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
  const p1 = api.refresh(); // защёлка встаёт на host-1, ответ пока не пришёл

  baseEl.value = 'http://host-2/v1';
  const p2 = api.refresh(); // URL сменился — защёлка переставлена на host-2

  // Актуальный запрос отвечает первым — вот тот порядок, ради которого
  // нужна защёлка: не "поздний ответ вообще не пришёл", а "пришёл после
  // актуального и не должен его затереть". Если резолвить в обратном
  // порядке (сперва устаревший, потом актуальный), актуальный всё равно
  // пишет последним и молча маскирует отсутствие защёлки.
  pending[1]({ models: [{ id: 'fresh' }] }); // ответ на актуальный host-2
  await p2;
  pending[0]({ models: [{ id: 'STALE' }] }); // поздний ответ на host-1, пришедший после
  await p1;

  const ids = hostEl.querySelector('#tva-models').children.map((o) => o.value);
  check('в списке только модель актуального URL', ids, ['fresh']);
  check('устаревшая модель не просочилась', ids.includes('STALE'), false);
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
