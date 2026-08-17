/**
 * TVAgent — где живёт панель.
 *
 * Гоняет настоящий panel-mount.js под самодельным DOM и поддельным bridge.
 * Проверяет то, что дорого сломать: overlay остаётся рабочим путём (у
 * анонимной сессии виджетбара нет вовсе — widgetbar-creator.ts зовёт
 * createWidgetBar только под window.is_authenticated), а после bfcache
 * restore (pageshow с persisted=true) панель не остаётся висеть в
 * отсоединённом узле — драйвер на pagehide уносит саму страницу виджетбара
 * (teardown() → layout.removePage() → page.element().remove()), но не
 * трогает то, что мы в неё вложили, так что root и вся его переписка
 * обязаны доехать до нового узла тем же самым объектом, а не пересобранными
 * заново.
 *
 * Подделка appendChild обязана вести себя как настоящий DOM — при переносе
 * убирать узел из старого родителя, — иначе тест на «тот же root переехал»
 * зелёный за счёт того, что подделка держит его сразу в двух местах.
 *
 *   node mount-test.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('./extension/src/content/panel-mount.js', import.meta.url).pathname,
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

/**
 * Узел с настоящей семантикой appendChild: перенос убирает его из старого
 * родителя. classList.toggle без второго аргумента переключает класс — как у
 * настоящего DOMTokenList.toggle(token) — а не только явно ставит/снимает.
 */
function node(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    style: {},
    children: [],
    parent: null,
    listeners: {},
    classes: new Set(),
    classList: {
      // Настоящий DOMTokenList.add/remove принимает сразу несколько
      // токенов — panel-mount.js зовёт add('tva-overlay', 'tva-hidden')
      // одним вызовом, и подделка обязана съедать оба, а не только первый.
      add: (...cs) => cs.forEach((c) => e.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => e.classes.delete(c)),
      contains: (c) => e.classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (e.classes.has(c)) e.classes.delete(c);
          else e.classes.add(c);
        } else if (force) e.classes.add(c);
        else e.classes.delete(c);
        return e.classes.has(c);
      },
    },
    appendChild(child) {
      if (child.parent) child.parent._detach(child);
      child.parent = e;
      e.children.push(child);
      return child;
    },
    _detach(child) {
      const i = e.children.indexOf(child);
      if (i !== -1) e.children.splice(i, 1);
    },
    remove() {
      if (e.parent) e.parent._detach(e);
      e.parent = null;
    },
    addEventListener(type, fn) {
      (e.listeners[type] = e.listeners[type] || []).push(fn);
    },
  };
  return e;
}

function makeDocument() {
  const documentElement = node('html');
  return {
    documentElement,
    createElement: (tag) => node(tag),
    // Настоящий getElementById видит только то, что реально в дереве
    // документа, — отсоединённый узел найден не будет, даже если у него
    // остался тот самый id.
    getElementById(id) {
      const walk = (n) => {
        if (n.id === id) return n;
        for (const c of n.children) {
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(documentElement);
    },
  };
}

function makeWindow() {
  const listeners = {};
  return {
    innerWidth: 1200,
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
    // Возвращает результаты вызова каждого обработчика (в т.ч. промисы
    // async-хендлеров), чтобы тест мог дождаться их завершения через
    // Promise.all, а не гадать с sleep.
    fire: (type, evt) => (listeners[type] || []).slice().map((fn) => fn(evt || {})),
  };
}

function makeChrome(store = {}) {
  return {
    storage: {
      local: {
        get: async (key) => (typeof key === 'string' ? (key in store ? { [key]: store[key] } : {}) : { ...store }),
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  };
}

/** Поддельный bridge.call('widgetbar_mount') кладёт новую страницу в дерево документа. */
function makeMountedPage(doc) {
  const page = doc.createElement('div');
  page.id = 'tva-widgetbar-page';
  doc.documentElement.appendChild(page);
  return page;
}

function load({ window: win, document: doc, chrome: chr, bridge }) {
  win.TVAgentBridge = bridge;
  new Function('window', 'document', 'chrome', src)(win, doc, chr);
  return win.TVAgentMount;
}

console.log('\n— нативный путь —');

{
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  let mountCalls = 0;
  const bridge = {
    on() {},
    async call(method) {
      if (method === 'widgetbar_mount') {
        mountCalls++;
        const page = makeMountedPage(doc);
        return { ok: true, pageId: page.id };
      }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  const { root, mode } = await Mount.mount();

  check('native: mode', mode, 'native');
  check('native: widgetbar_mount вызван один раз', mountCalls, 1);
  check('native: root вложен в страницу виджетбара', root.parent && root.parent.id, 'tva-widgetbar-page');
  check(
    'native: классы — только tva-native, без overlay/hidden',
    [root.classList.contains('tva-native'), root.classList.contains('tva-overlay'), root.classList.contains('tva-hidden')],
    [true, false, false]
  );
  check('native: resizer не добавлен', root.children.some((c) => c.className === 'tva-resizer'), false);
}

console.log('\n— overlay-путь —');

{
  // Анонимная сессия: window.widgetbar вообще нет, driver.js бросает —
  // ровно то, что видит content script, когда widgetbar-creator.ts не
  // построил бар (createWidgetBar только под window.is_authenticated).
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  const infoLogs = [];
  const originalInfo = console.info;
  console.info = (...args) => infoLogs.push(args.join(' '));

  const bridge = {
    on() {},
    async call(method) {
      if (method === 'widgetbar_mount') {
        throw new Error('TradingView widget bar is not on this page (anonymous session?).');
      }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  const { root, mode } = await Mount.mount();
  console.info = originalInfo;

  check('overlay: mode', mode, 'overlay');
  check('overlay: root вложен прямо в documentElement', root.parent === doc.documentElement, true);
  check(
    'overlay: классы — tva-overlay и tva-hidden, без native',
    [root.classList.contains('tva-overlay'), root.classList.contains('tva-hidden'), root.classList.contains('tva-native')],
    [true, true, false]
  );
  check('overlay: resizer добавлен', root.children.some((c) => c.className === 'tva-resizer'), true);
  check('overlay: в консоль ушла заметка о причине', infoLogs.some((s) => /widget bar unavailable/.test(s)), true);
}

console.log('\n— toggle —');

{
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  const state = { active: false };
  const bridge = {
    calls: [],
    on() {},
    async call(method) {
      bridge.calls.push(method);
      if (method === 'widgetbar_mount') return { ok: true, pageId: makeMountedPage(doc).id };
      if (method === 'widgetbar_state') return { active: state.active };
      if (method === 'widgetbar_activate') { state.active = true; return { ok: true }; }
      if (method === 'widgetbar_deactivate') { state.active = false; return { ok: true }; }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  await Mount.mount();

  bridge.calls.length = 0;
  await Mount.toggle();
  check('native toggle: спрашивает state, затем activate', bridge.calls, ['widgetbar_state', 'widgetbar_activate']);

  bridge.calls.length = 0;
  await Mount.toggle();
  check('native toggle ещё раз: спрашивает state, затем deactivate', bridge.calls, ['widgetbar_state', 'widgetbar_deactivate']);
}

{
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  const bridge = {
    calls: [],
    on() {},
    async call(method) {
      bridge.calls.push(method);
      if (method === 'widgetbar_mount') throw new Error('no widget bar');
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  const { root } = await Mount.mount();

  bridge.calls.length = 0;
  check('overlay начинает скрытой', root.classList.contains('tva-hidden'), true);
  await Mount.toggle();
  check('overlay toggle показывает панель, bridge не тронут', [root.classList.contains('tva-hidden'), bridge.calls], [false, []]);
  await Mount.toggle();
  check('overlay toggle прячет обратно, bridge всё ещё не тронут', [root.classList.contains('tva-hidden'), bridge.calls], [true, []]);
}

console.log('\n— onActive —');

{
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  let handler = null;
  let onCalls = 0;
  const bridge = {
    on(type, fn) {
      onCalls++;
      if (type === 'widgetbar-active') handler = fn;
    },
    async call(method) {
      if (method === 'widgetbar_mount') return { ok: true, pageId: makeMountedPage(doc).id };
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  await Mount.mount();

  const seen = [];
  Mount.onActive((active) => seen.push(active));
  handler({ active: true });
  handler({ active: false });
  check('onActive получает то, что шлёт bridge', seen, [true, false]);
  check('bridge.on вызван один раз', onCalls, 1);
}

console.log('\n— bfcache restore —');

{
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  let mountCalls = 0;
  let onCalls = 0;
  const bridge = {
    on() { onCalls++; },
    async call(method) {
      if (method === 'widgetbar_mount') {
        mountCalls++;
        return { ok: true, pageId: makeMountedPage(doc).id };
      }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  const { root } = await Mount.mount();
  const firstHost = root.parent;
  check('первое монтирование создало страницу', mountCalls, 1);

  // Переписка внутри панели — то, что обязано пережить restore нетронутым.
  const chatMsg = doc.createElement('div');
  chatMsg.className = 'tva-msg';
  root.appendChild(chatMsg);

  // Имитация teardown() из driver.js на pagehide: уходит сам элемент
  // страницы (layout.removePage → page.element().remove()), но не то, что
  // content script в него вложил, — root остаётся дочерним узлом firstHost,
  // просто вместе с ним отсоединяется от документа.
  firstHost.remove();
  check('старая страница отсоединена от документа', doc.getElementById('tva-widgetbar-page'), null);
  check(
    'root (с сообщением внутри) уехал вместе со старым узлом, а не был пересоздан',
    [firstHost.children.includes(root), root.children.includes(chatMsg)],
    [true, true]
  );

  await Promise.all(win.fire('pageshow', { persisted: true }));

  check('pageshow с persisted=true заново зовёт widgetbar_mount', mountCalls, 2);
  const newHost = doc.getElementById('tva-widgetbar-page');
  check('это новая страница, не старая', newHost !== firstHost, true);
  check('тот же самый root переехал в новую страницу', root.parent === newHost, true);
  check('со старой страницы root снят', firstHost.children.includes(root), false);
  check('сообщение внутри root пережило переезд', root.children.includes(chatMsg), true);
  check('слушатель widgetbar-active не задвоился при перемонтировании', onCalls, 1);
}

{
  // persisted=false — обычная навигация, не bfcache; перемонтирование не нужно.
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  let mountCalls = 0;
  const bridge = {
    on() {},
    async call(method) {
      if (method === 'widgetbar_mount') {
        mountCalls++;
        return { ok: true, pageId: makeMountedPage(doc).id };
      }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  await Mount.mount();
  check('после обычного монтирования', mountCalls, 1);

  await Promise.all(win.fire('pageshow', { persisted: false }));
  check('pageshow с persisted=false ничего не перемонтирует', mountCalls, 1);
}

{
  // overlay-сессия (анонимная) тоже переживает pageshow — драйвер её не
  // трогал, перемонтировать нечего.
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  let mountCalls = 0;
  const bridge = {
    on() {},
    async call(method) {
      if (method === 'widgetbar_mount') {
        mountCalls++;
        throw new Error('no widget bar');
      }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  const { root } = await Mount.mount();
  check('overlay-монтирование не звало widgetbar_mount дважды', mountCalls, 1);

  await Promise.all(win.fire('pageshow', { persisted: true }));
  check('overlay-сессия на persisted=true не перемонтирует', mountCalls, 1);
  check('root остался там же', root.parent === doc.documentElement, true);
}

console.log('\n— bfcache restore: отказ на восстановлении —');

{
  // Пользователь разлогинился в другой вкладке — виджетбара на
  // restore-попытке уже нет. Панель не должна остаться висеть в
  // отсоединённом узле: она обязана откатиться на overlay, как при первом
  // отказе на старте.
  const doc = makeDocument();
  const win = makeWindow();
  const chr = makeChrome();
  let shouldFail = false;
  let mountCalls = 0;
  const bridge = {
    on() {},
    async call(method) {
      if (method === 'widgetbar_mount') {
        mountCalls++;
        if (shouldFail) throw new Error('TradingView widget bar is not on this page (anonymous session?).');
        return { ok: true, pageId: makeMountedPage(doc).id };
      }
      throw new Error('unexpected call ' + method);
    },
  };
  const Mount = load({ window: win, document: doc, chrome: chr, bridge });
  const { root } = await Mount.mount();
  const firstHost = root.parent;
  firstHost.remove();
  shouldFail = true;

  await Promise.all(win.fire('pageshow', { persisted: true }));

  check('отказавшее перемонтирование откатывается на overlay', Mount.mode(), 'overlay');
  check('root переехал на documentElement', root.parent === doc.documentElement, true);
  check(
    'классы переставлены на overlay/hidden, native снят',
    [root.classList.contains('tva-overlay'), root.classList.contains('tva-hidden'), root.classList.contains('tva-native')],
    [true, true, false]
  );
  check('resizer подключён при откате', root.children.some((c) => c.className === 'tva-resizer'), true);
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
