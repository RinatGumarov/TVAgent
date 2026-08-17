/**
 * TVAgent — оболочка панели (шапка, context row, empty state, композер, boot).
 *
 * Гоняет настоящий panel.js под самодельным DOM и поддельными
 * TVAgentMount/TVAgentSettings/TVAgentBridge/TVAgentRuntime/TVAgentChat —
 * этот файл единственный, кто их реально вызывает по-новому, так что тест
 * подделывает их интерфейсы, а не их внутренности (те уже проверены
 * mount-test.mjs, settings-screen-test.mjs, chat-test.mjs).
 *
 * Фабрика DOM ниже — компиляция парсера из settings-screen-test.mjs
 * (id/dataset/classList/querySelector по тег+#id+.class+[attr], void-теги)
 * с добавкой insertAdjacentHTML из chat-test.mjs (panel.js строит шапку
 * именно через root.insertAdjacentHTML, а не innerHTML — это специально
 * подчёркнуто в комментарии над build(), чтобы не снести уже вложенный
 * resizer) и новых полей/методов, которых не было ни там, ни там, потому
 * что ни один из старых модулей их не трогал: value (input/textarea),
 * disabled (в т.ч. из атрибута disabled в разметке), style (обычный
 * объект), scrollHeight, focus() со счётчиком вызовов и setAttribute —
 * panel.js единственный, кто зовёт sendBtn.setAttribute('aria-label', …).
 *
 * Что подделка DOM моделирует по-настоящему:
 *   - insertAdjacentHTML('beforeend', …) и innerHTML — разбор вложенных
 *     тегов с атрибутами (id, class, data-*, rows, placeholder, title,
 *     aria-label, disabled без значения) в настоящее дерево, а не в плоскую
 *     строку;
 *   - querySelector/querySelectorAll по тег/#id/.class/[attr] и их
 *     сочетаниям, обходом потомков в document order — ровно то, чем
 *     реально пользуется panel.js (root.querySelector('#tva-list'),
 *     statusEl.querySelector('span') и т.д.);
 *   - classList.add/remove/contains/toggle(force), пересчитываемый из
 *     className, а не отдельный Set;
 *   - disabled — атрибут disabled в шаблоне превращается в свойство
 *     el.disabled = true при разборе (как в настоящем DOM: булев атрибут
 *     задаёт начальное свойство), а дальше panel.js читает и пишет его как
 *     обычное свойство;
 *   - value — обычное read/write свойство, как у настоящих
 *     input/textarea (никакого разбора — им управляет только JS);
 *   - click(el)/fireInput(el)/fireKeydown(el, opts) — вызывают ровно те
 *     слушатели, что повесил addEventListener на этом элементе; panel.js
 *     вешает все свои обработчики впрямую на цель (без делегирования), так
 *     что всплытие не нужно и не подделывается.
 *
 * Что НЕ моделирует:
 *   - innerHTML на чтение (геттер-заглушка) и постоянную сериализацию
 *     сущностей (&#8593; и т.п. остаются как есть, не раскодируются) —
 *     panel.js их не читает обратно, только пишет и красит классами;
 *   - textarea.scrollHeight как функцию реальной раскладки — всегда 0,
 *     что для Math.min(0, 160) безопасно и не влияет на логику, которую
 *     проверяет этот файл (диктует только строку style.height, не
 *     заблокировано ли что-то);
 *   - самозакрывающийся синтаксис ("/>") — в разметке panel.js его нет.
 *
 *   node panel-test.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('./extension/src/content/panel.js', import.meta.url).pathname,
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
    // Булев атрибут disabled в разметке — это стартовое состояние свойства
    // .disabled, ровно как в настоящем DOM. Только у send-кнопки это и есть
    // в шаблоне panel.js.
    if ('disabled' in el.attrs) el.disabled = true;

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
    disabled: false,
    style: {},
    scrollHeight: 0,
    scrollTop: 0,
    _focusCount: 0,

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
    insertAdjacentHTML(pos, html) {
      if (pos !== 'beforeend') throw new Error('fake insertAdjacentHTML: unsupported position ' + pos);
      parseFragment(html).forEach((n) => {
        n.parent = el;
        el.children.push(n);
      });
    },
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
    focus() {
      el._focusCount++;
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

function click(el) {
  (el.listeners.click || []).forEach((fn) => fn({}));
}
function fireInput(el) {
  (el.listeners.input || []).forEach((fn) => fn({}));
}
function fireKeydown(el, { key, shiftKey } = {}) {
  const evt = { key, shiftKey: !!shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  (el.listeners.keydown || []).forEach((fn) => fn(evt));
  return evt;
}

// -------------------------------------------------------------- моки chrome

function makeChrome() {
  const messageListeners = [];
  return {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    _fireMessage(msg) { messageListeners.slice().forEach((fn) => fn(msg)); },
  };
}

// --------------------------------------------------------- моки TVAgent*

function makeChatModule(doc) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function create(listEl) {
    const log = { user: [], notice: [], error: [], clear: 0, startRun: 0, endRun: 0 };
    function addMsg(kind, text) {
      const el = doc.createElement('div');
      el.className = 'tva-msg ' + kind;
      el.textContent = text;
      listEl.appendChild(el);
      return el;
    }
    return {
      log,
      clear() { log.clear++; listEl.children = []; },
      user(t) { log.user.push(t); return addMsg('user', t); },
      notice(t) { log.notice.push(t); return addMsg('notice', t); },
      error(t) { log.error.push(t); return addMsg('error', t); },
      startRun() { log.startRun++; },
      endRun() { log.endRun++; },
      onBlockStart() {},
      onThinking() {},
      onText() {},
      onToolStart() {},
      onToolResult() {},
      onConfirm() { return Promise.resolve(true); },
    };
  }

  return { esc, create };
}

/** mount-мок с управляемым мгновенным результатом (mode/root заданы сразу). */
function makeMountMock(mode, root) {
  let calls = 0;
  const handlers = [];
  let toggleCalls = 0;
  return {
    async mount() { calls++; return { root, mode }; },
    onActive(fn) { handlers.push(fn); },
    async toggle() { toggleCalls++; },
    get calls() { return calls; },
    get toggleCalls() { return toggleCalls; },
    handlers,
  };
}

function makeSettingsMock({ ready = true, autoApprove = false } = {}) {
  let refreshCalls = 0;
  let lastOnChange = null;
  return {
    create(hostEl, opts) {
      lastOnChange = opts.onChange;
      return {
        ready: Promise.resolve(ready),
        autoApprove: () => autoApprove,
        refresh: () => { refreshCalls++; },
        current: () => ({ provider: 'anthropic', model: 'claude-opus-5' }),
      };
    },
    get refreshCalls() { return refreshCalls; },
    get lastOnChange() { return lastOnChange; },
  };
}

function makeBridgeMock(capsValue) {
  return { probeWhenReady: async () => capsValue };
}

function makeRuntimeMock() {
  const instances = [];
  class Agent {
    constructor(opts) {
      this.capabilities = opts.capabilities;
      this.handlers = opts.handlers;
      this.sendCalls = [];
      this.cancelCalls = 0;
      this.resetCalls = 0;
      instances.push(this);
    }
    send(t) { this.sendCalls.push(t); }
    cancel() { this.cancelCalls++; }
    reset() { this.resetCalls++; }
  }
  return { Agent, instances };
}

function caps(overrides = {}) {
  return {
    tradingViewApi: true,
    chart: true,
    loggedIn: true,
    symbol: 'BTCUSD',
    resolution: '60',
    pine: true,
    warnings: [],
    ...overrides,
  };
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

function load({ mount, settings, bridge, runtime, chat }) {
  const win = {};
  const doc = makeDocument();
  win.TVAgentChat = chat || makeChatModule(doc);
  win.TVAgentMount = mount;
  win.TVAgentSettings = settings;
  win.TVAgentBridge = bridge;
  win.TVAgentRuntime = runtime;
  const chr = makeChrome();
  new Function('window', 'document', 'chrome', src)(win, doc, chr);
  return { win, doc, chrome: chr };
}

/**
 * Полный успешный boot с моками по умолчанию (можно переопределить любую
 * часть). Возвращает готовые ссылки на узлы и агента, дождавшись, пока
 * boot() реально дойдёт до конца (все промисы в моках уже resolved, но
 * boot() всё равно проходит несколько await подряд — flush() дожидается
 * их все за счёт границы макрозадачи, а не гадания с числом await Promise.resolve()).
 */
async function bootedPanel(overrides = {}) {
  const root = makeElementRoot();
  const mode = overrides.mode || 'overlay';
  const mount = overrides.mount || makeMountMock(mode, root);
  const settings = overrides.settings || makeSettingsMock(overrides.settingsOpts);
  const bridge = overrides.bridge || makeBridgeMock(overrides.caps || caps());
  const runtime = overrides.runtime || makeRuntimeMock();

  const { win, doc, chrome } = load({ mount, settings, bridge, runtime, chat: overrides.chat });
  await flush();
  await flush();

  const q = (sel) => root.querySelector(sel);
  return {
    win, doc, chrome, root, mount, settings, bridge, runtime,
    listEl: q('#tva-list'),
    settingsEl: q('#tva-settings'),
    emptyEl: q('#tva-empty'),
    inputEl: q('#tva-input'),
    sendBtn: q('#tva-send'),
    statusEl: q('#tva-status'),
    contextEl: q('#tva-where'),
    composerEl: q('.tva-composer'),
    agent: runtime.instances[0] || null,
  };
}

function makeElementRoot() {
  return makeDocument().createElement('div');
}

// ============================================================================
console.log('\n— boot: mount перед build —');

{
  let resolveMount;
  const mountPromise = new Promise((r) => (resolveMount = r));
  const root = makeElementRoot();
  let mountCalls = 0;
  const mount = {
    async mount() { mountCalls++; return mountPromise; },
    onActive() {},
    async toggle() {},
  };
  const settings = makeSettingsMock({ ready: true });
  const bridge = makeBridgeMock(caps());
  const runtime = makeRuntimeMock();

  load({ mount, settings, bridge, runtime });

  check('mount() вызван один раз сразу при загрузке', mountCalls, 1);
  check('build() ещё не выполнился — root пуст, пока mount() не resolved', root.children.length, 0);

  resolveMount({ root, mode: 'overlay' });
  // mount.mount() выше сама async, поэтому её возвращаемый промис не есть
  // mountPromise напрямую, а следует за ним ("chains") — это лишний тик
  // микрозадачи сверх разрешения mountPromise. await mountPromise здесь
  // (эксперимент, оставленный закомментированным намеренно) резолвится на
  // тик раньше, чем то, что boot() реально ждёт (await window.TVAgentMount.mount()),
  // и тогда эта проверка ловит build() ещё не выполнившимся — не потому что
  // порядок mount-перед-build нарушен, а потому что тест смотрит слишком
  // рано. flush() пережидает границу макрозадачи, чего достаточно для
  // любого числа микрозадач подряд.
  await flush();
  check('после resolve mount() — build() уже выполнился (шапка появилась)', root.children.length > 0, true);
  check('шапка вставлена как заголовок', root.querySelector('.tva-header') !== null, true);
}

console.log('\n— boot: settings.ready решает, открывается ли экран настроек —');

{
  const h = await bootedPanel({ settingsOpts: { ready: false } });
  check(
    'ready=false: settings-экран открыт (settingsEl без tva-hidden)',
    h.settingsEl.classList.contains('tva-hidden'),
    false
  );
  check('ready=false: список скрыт', h.listEl.classList.contains('tva-hidden'), true);
  check('ready=false: композер скрыт', h.composerEl.classList.contains('tva-hidden'), true);
  check('ready=false: empty state скрыт (мы на экране настроек)', h.emptyEl.classList.contains('tva-hidden'), true);
}

{
  const h = await bootedPanel({ settingsOpts: { ready: true } });
  check('ready=true: settings-экран остался закрыт', h.settingsEl.classList.contains('tva-hidden'), true);
  check('ready=true: список виден', h.listEl.classList.contains('tva-hidden'), false);
  check('ready=true: композер виден', h.composerEl.classList.contains('tva-hidden'), false);
}

console.log('\n— boot: провал probe показывает ошибку и не создаёт Agent —');

{
  const h = await bootedPanel({ caps: caps({ tradingViewApi: false, chart: false }) });
  check('Agent не создан', h.runtime.instances.length, 0);
  check('статус — no chart', h.statusEl.className, 'tva-status err');

  const errCall = h.listEl.querySelector('.tva-msg.error');
  check('в списке появилось сообщение об ошибке', errCall !== null, true);
  check(
    'текст сообщения — про TradingView API и /chart/',
    errCall.textContent.includes('Could not reach the TradingView API'),
    true
  );
}

console.log('\n— boot: успешный probe создаёт Agent —');

{
  const h = await bootedPanel({ caps: caps({ loggedIn: true }) });
  check('Agent создан ровно один раз', h.runtime.instances.length, 1);
  check('статус — connected', h.statusEl.className, 'tva-status ok');
}

{
  const h = await bootedPanel({ caps: caps({ loggedIn: false }) });
  check('Agent всё равно создан при loggedIn=false (это только статус, не блокер)', h.runtime.instances.length, 1);
  check('статус — logged out (warn)', h.statusEl.className, 'tva-status warn');
}

// ============================================================================
console.log('\n— onActive: регистрируется только в native, фокусирует инпут —');

{
  const h = await bootedPanel({ mode: 'native' });
  check('в native-режиме onActive зарегистрирован', h.mount.handlers.length, 1);

  const handler = h.mount.handlers[0];
  check('до вызова focus() не звался', h.inputEl._focusCount, 0);
  handler(true);
  check('active=true — инпут сфокусирован', h.inputEl._focusCount, 1);
  handler(false);
  check('active=false — focus() больше не звался', h.inputEl._focusCount, 1);
}

{
  const h = await bootedPanel({ mode: 'overlay' });
  check('в overlay-режиме onActive НЕ регистрируется', h.mount.handlers.length, 0);
}

// ============================================================================
console.log('\n— send: пустой и пробельный ввод не отправляются —');

{
  const h = await bootedPanel();
  h.inputEl.value = '';
  fireInput(h.inputEl);
  click(h.sendBtn);
  check('пустой ввод: agent.send не позван', h.agent.sendCalls, []);
}

{
  const h = await bootedPanel();
  h.inputEl.value = '   \n  ';
  fireInput(h.inputEl);
  click(h.sendBtn);
  check('только пробелы: agent.send не позван', h.agent.sendCalls, []);
}

console.log('\n— send: кнопка disabled без текста, enabled с текстом —');

{
  const h = await bootedPanel();
  check('изначально (пустой инпут) кнопка disabled', h.sendBtn.disabled, true);

  h.inputEl.value = 'hello';
  fireInput(h.inputEl);
  check('после ввода текста кнопка enabled', h.sendBtn.disabled, false);

  h.inputEl.value = '';
  fireInput(h.inputEl);
  check('после очистки снова disabled', h.sendBtn.disabled, true);
}

console.log('\n— send: во время busy повторная отправка не проходит —');

{
  const h = await bootedPanel();
  h.inputEl.value = 'first message';
  fireInput(h.inputEl);
  click(h.sendBtn); // запускает run, busy=true

  check('первое сообщение дошло до agent.send', h.agent.sendCalls, ['first message']);

  // Enter всегда зовёт submit() (обработчик keydown не проверяет busy сам —
  // это делает submit() внутри), так что это и есть путь, которым можно
  // проверить именно busy-заслон submit(), а не ветку кнопки (та во время
  // busy вообще не отправляет, а отменяет — см. ниже).
  h.inputEl.value = 'second message while busy';
  fireInput(h.inputEl);
  fireKeydown(h.inputEl, { key: 'Enter' });
  check('вторая отправка во время busy не прошла (submit() сам отсёк по busy)', h.agent.sendCalls, ['first message']);
}

// ============================================================================
console.log('\n— run lifecycle: startRun/endRun —');

{
  const h = await bootedPanel();
  h.inputEl.value = 'go';
  fireInput(h.inputEl);
  click(h.sendBtn);

  check('startRun: кнопка получила класс stop', h.sendBtn.classList.contains('stop'), true);
  check('startRun: aria-label — Stop', h.sendBtn.attrs['aria-label'], 'Stop');
  check('startRun: инпут очищен submit()', h.inputEl.value, '');
  check('startRun: кнопка enabled, хотя инпут пуст', h.sendBtn.disabled, false);
  check('startRun: статус — working…', h.statusEl.className, 'tva-status warn');

  // endRun обязан заново вычислить disabled из ТЕКУЩЕГО значения инпута, а
  // не унаследовать false от startRun и не всегда ставить true. Меняем
  // инпут во время рана — то, что реально может случиться, пока агент
  // работает, — и проверяем, что endRun это видит.
  h.inputEl.value = 'draft typed while agent was working';
  h.agent.handlers.onDone({ stopReason: 'end_turn' });

  check('endRun: класс stop снят', h.sendBtn.classList.contains('stop'), false);
  check('endRun: aria-label — Send', h.sendBtn.attrs['aria-label'], 'Send');
  check(
    'endRun: disabled пересчитан из текущего (непустого) инпута — false, а не унаследован',
    h.sendBtn.disabled,
    false
  );
  check('endRun: статус — connected (ok)', h.statusEl.className, 'tva-status ok');
}

{
  const h = await bootedPanel();
  h.inputEl.value = 'go';
  fireInput(h.inputEl);
  click(h.sendBtn);

  h.inputEl.value = ''; // ничего не осталось напечатано
  h.agent.handlers.onDone({ stopReason: 'end_turn' });
  check('endRun с пустым инпутом на момент завершения — снова disabled', h.sendBtn.disabled, true);
}

{
  const h = await bootedPanel();
  h.inputEl.value = 'go';
  fireInput(h.inputEl);
  click(h.sendBtn);

  h.agent.handlers.onError(new Error('boom'));
  check('onError переводит статус в err', h.statusEl.className, 'tva-status err');
  check('onError показывает текст ошибки в чате', h.listEl.querySelector('.tva-msg.error').textContent, 'boom');
  check('onError тоже снимает stop-класс (run завершён)', h.sendBtn.classList.contains('stop'), false);
}

console.log('\n— run lifecycle: кнопка Stop отменяет, а не отправляет —');

{
  const h = await bootedPanel();
  h.inputEl.value = 'go';
  fireInput(h.inputEl);
  click(h.sendBtn); // старт рана, busy=true

  h.inputEl.value = 'this must not be sent';
  fireInput(h.inputEl);
  click(h.sendBtn); // во время busy клик по той же кнопке — это Stop

  check('повторный клик во время busy зовёт agent.cancel()', h.agent.cancelCalls, 1);
  check('повторный клик во время busy НЕ добавляет новую отправку', h.agent.sendCalls, ['go']);
}

// ============================================================================
console.log('\n— suggestions: клик отправляет сразу, не заполняя инпут —');

{
  const h = await bootedPanel();
  const card = h.root.querySelector('.tva-suggestion');
  check('карточка подсказки на месте', card !== null, true);

  check('до клика инпут пуст', h.inputEl.value, '');
  click(card);

  check('клик по подсказке сразу зовёт agent.send с её текстом', h.agent.sendCalls, ['What am I looking at?']);
  check('инпут НЕ заполнился текстом подсказки — это осознанное поведение, не заполнение поля', h.inputEl.value, '');
}

// ============================================================================
console.log('\n— screens: showScreen(settings) прячет список и композер —');

{
  const h = await bootedPanel();
  click(h.root.querySelector('#tva-gear'));

  check('settings открыт', h.settingsEl.classList.contains('tva-hidden'), false);
  check('список скрыт', h.listEl.classList.contains('tva-hidden'), true);
  check('композер скрыт', h.composerEl.classList.contains('tva-hidden'), true);
  check('empty state скрыт (мы в settings)', h.emptyEl.classList.contains('tva-hidden'), true);
  check('settings.refresh() был позван при открытии', h.settings.refreshCalls, 1);
}

console.log('\n— screens: возврат назад восстанавливает список и композер —');

{
  const h = await bootedPanel();
  click(h.root.querySelector('#tva-gear')); // открыть
  click(h.root.querySelector('#tva-gear')); // закрыть

  check('settings закрыт обратно', h.settingsEl.classList.contains('tva-hidden'), true);
  check('список снова виден', h.listEl.classList.contains('tva-hidden'), false);
  check('композер снова виден', h.composerEl.classList.contains('tva-hidden'), false);
}

console.log('\n— screens: empty state виден только когда список пуст и мы не в settings —');

{
  const h = await bootedPanel();
  check('список изначально пуст — empty state виден', h.emptyEl.classList.contains('tva-hidden'), false);
}

{
  // Кладём сообщение в список напрямую (минуя submit(), у которого свой
  // особый порядок вызовов — см. отдельный блок про него ниже) и заново
  // проходим settings-туда-обратно: toggleSettings() всегда зовёт
  // showScreen(), а тот всегда пересчитывает isEmpty() по ТЕКУЩЕМУ
  // состоянию списка — это единственный путь, которым empty state
  // гарантированно пересчитывается.
  const h = await bootedPanel();
  const dummy = h.doc.createElement('div');
  dummy.className = 'tva-msg user';
  h.listEl.appendChild(dummy);

  click(h.root.querySelector('#tva-gear')); // settings: empty обязан быть скрыт, список не пуст
  check('в settings-экране empty скрыт независимо от пустоты списка', h.emptyEl.classList.contains('tva-hidden'), true);

  click(h.root.querySelector('#tva-gear')); // назад в chat
  check('назад в chat, список не пуст — empty state скрыт', h.emptyEl.classList.contains('tva-hidden'), true);
}

{
  // Тот же переход, но список остаётся пуст — empty обязан остаться видимым.
  const h = await bootedPanel();
  click(h.root.querySelector('#tva-gear'));
  click(h.root.querySelector('#tva-gear'));
  check('назад в chat, список пуст — empty state снова виден', h.emptyEl.classList.contains('tva-hidden'), false);
}

console.log('\n— screens: submit() — реальный порядок вызовов на первом сообщении —');
{
  // submit() делает setEmpty(false), затем showScreen('chat') (который
  // пересчитывает empty по isEmpty()), и только ПОТОМ chat.user(trimmed)
  // добавляет сообщение в список. Значит showScreen видит список ещё
  // пустым и empty state возвращается видимым — это реальное поведение
  // самого этого (взятого дословно из плана) кода, а не выдуманный
  // "правильный" инвариант; проверяем именно то, что код действительно
  // делает, чтобы регрессия здесь была видна, а не была бы "и так работало".
  const h = await bootedPanel();
  h.inputEl.value = 'first ever message';
  fireInput(h.inputEl);
  click(h.sendBtn);

  check('после первого сообщения список больше не пуст', h.listEl.children.length > 0, true);
  check(
    'ПОРЯДОК ВЫЗОВОВ В submit(): showScreen() выполняется до chat.user(), поэтому empty state ' +
      'остаётся видимым сразу после первого сообщения, несмотря на то что список уже не пуст — ' +
      'см. отчёт задачи, помечено как concern, не баг этого теста',
    h.emptyEl.classList.contains('tva-hidden'),
    false
  );

  // Второе сообщение: на этот раз showScreen() видит список уже НЕ пустым
  // (он стал таким после первого chat.user()), так что тут расхождения нет.
  h.inputEl.value = 'second message';
  fireInput(h.inputEl);
  h.agent.handlers.onDone({}); // освобождаем busy, иначе второй submit() отсечётся
  click(h.sendBtn);
  check('на втором сообщении empty state корректно скрыт', h.emptyEl.classList.contains('tva-hidden'), true);
}

// ============================================================================
console.log('\n— бонус: New chat сбрасывает агента, чистит список и empty снова виден —');

{
  const h = await bootedPanel();
  const dummy = h.doc.createElement('div');
  dummy.className = 'tva-msg user';
  h.listEl.appendChild(dummy);
  h.emptyEl.classList.add('tva-hidden');

  click(h.root.querySelector('#tva-new'));

  check('New chat зовёт agent.reset()', h.agent.resetCalls, 1);
  check('New chat чистит список', h.listEl.children.length, 0);
  check('New chat возвращает на экран chat', h.settingsEl.classList.contains('tva-hidden'), true);
  check('New chat снова показывает empty state', h.emptyEl.classList.contains('tva-hidden'), false);
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
