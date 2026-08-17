/**
 * TVAgent — страница в виджетбаре TradingView.
 *
 * Гоняет настоящий driver.js против поддельного window.widgetbar. Проверяет то,
 * что дорого сломать: активация не должна ходить через onTabClick (он пишет наш
 * лист в настройки аккаунта), закрытие — возвращать ту вкладку, что была, а не
 * дёргать пользователя, если он сам ушёл на другую вкладку, и хранит для этого
 * саму страницу, а не индекс, который сдвигается при удалении чужих страниц.
 *
 * Подделка обязана держать контракт хоста, а не тот, который нам удобен: три
 * раза подряд расхождение между ней и TradingView прятало настоящий дефект.
 * Поэтому page.onActiveStateChange здесь бросает без tab (page.ts:89-93),
 * switchPage и setMinimizedState его дёргают (layout.ts:280-320, 263-278), а
 * createPage отдаёт страницу ровно в том виде, в каком её отдаёт хост, — без
 * tab и без имени.
 *
 *   node widgetbar-test.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('./extension/src/injected/driver.js', import.meta.url).pathname,
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

/**
 * Наблюдаемое значение с тем же интерфейсом, что у TradingView. Без аргумента
 * ведёт себя как `new WatchedValue()` — .value() === undefined, как у
 * реального layout.isMinimized до первого syncWidth (layout.ts:65).
 */
function watched(value) {
  const subs = [];
  return {
    value: () => value,
    setValue: (v) => {
      value = v;
      subs.slice().forEach((fn) => fn(v));
    },
    subscribe: (fn) => subs.push(fn),
    // WatchedValue.unsubscribe(cb) снимает все совпавшие, без аргумента — все
    // (packages/common/src/watched-value.ts).
    unsubscribe: (fn) => {
      if (!fn) {
        subs.length = 0;
        return;
      }
      for (let i = subs.length; i--;) if (subs[i] === fn) subs.splice(i, 1);
    },
    // Только для тестов: сколько подписчиков сейчас висит.
    count: () => subs.length,
  };
}

// ------------------------------------------------------------------ DOM

/**
 * Живые MutationObserver'ы текущего прогона. Настоящий зовёт колбэк пакетом и
 * микротаской; здесь — синхронно, то есть строже: если драйвер на вставке
 * кнопки спровоцирует новую вставку, тест уйдёт в переполнение стека, а не
 * тихо разложит это по тикам.
 */
const mutationObservers = [];
function notifyObservers(target) {
  mutationObservers.slice().forEach((o) => {
    if (!o.connected || o.target !== target) return;
    o.calls++;
    o.cb([], o);
  });
}

/**
 * Селекторы, которые драйверу позволено спрашивать. Всё остальное — ошибка:
 * подделка не должна молча угадывать семантику нового селектора и оставлять
 * зелёными проверки, которые уже ничего не значат.
 */
const BUTTON_SELECTORS = [
  'button[data-name][aria-pressed="false"]:not(:disabled)',
  'button[data-name]:not(:disabled)',
];
const DOCUMENT_SELECTORS = ['.widgetbar-pagescontent', '[data-name="right-toolbar"]'];

function unknownSelector(sel, known) {
  return new Error(
    `подделка не знает селектор ${JSON.stringify(sel)} (знает ${known.join(', ')}) — ` +
      'обнови её осознанно вместе с драйвером'
  );
}

/**
 * Минимальный узел. querySelector понимает ровно те селекторы, которыми
 * пользуется драйвер, — общего движка CSS тут нет и не нужно.
 */
function node(tag, attrs = {}) {
  const e = {
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    classes: new Set(),
    children: [],
    listeners: {},
    parent: null,
    className: '',
    textContent: '',
    id: '',
    setAttribute: (k, v) => { e.attrs[k] = String(v); },
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
    classList: {
      add: (c) => e.classes.add(c),
      remove: (c) => e.classes.delete(c),
      toggle: (c, on) => (on ? e.classes.add(c) : e.classes.delete(c)),
    },
    appendChild(child) {
      child.parent = e;
      e.children.push(child);
      notifyObservers(e);
      return child;
    },
    insertBefore(child, anchor) {
      const i = anchor ? e.children.indexOf(anchor) : -1;
      child.parent = e;
      if (i === -1) e.children.push(child);
      else e.children.splice(i, 0, child);
      notifyObservers(e);
      return child;
    },
    remove() {
      if (!e.parent) return;
      const parent = e.parent;
      const i = parent.children.indexOf(e);
      if (i !== -1) parent.children.splice(i, 1);
      e.parent = null;
      notifyObservers(parent);
    },
    contains(n) {
      for (let p = n; p; p = p.parent) if (p === e) return true;
      return false;
    },
    // cloneNode(false) копирует атрибуты и классы, но не детей и не слушателей.
    cloneNode: () => {
      const copy = node(tag, e.attrs);
      e.classes.forEach((c) => copy.classes.add(c));
      return copy;
    },
    addEventListener(type, fn) {
      (e.listeners[type] = e.listeners[type] || []).push(fn);
    },
    fire(type) {
      (e.listeners[type] || []).forEach((fn) => fn({}));
    },
    querySelector(sel) {
      if (!BUTTON_SELECTORS.includes(sel)) throw unknownSelector(sel, BUTTON_SELECTORS);
      const wantPressedFalse = sel.includes('aria-pressed="false"');
      const walk = (n) => {
        for (const c of n.children) {
          const ok =
            c.tagName === 'BUTTON' &&
            'data-name' in c.attrs &&
            !('disabled' in c.attrs) &&
            (!wantPressedFalse || c.attrs['aria-pressed'] === 'false');
          if (ok) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      return walk(e);
    },
  };
  return e;
}

/**
 * Правый тулбар в том порядке, в котором его рисует RightToolbar: сначала
 * CloseButton (только в fullscreen, aria-pressed не ставит — close-button.tsx),
 * потом вкладки, у активной aria-pressed="true" (tab-button.tsx:54), потом
 * Filler — на нём и заканчивается верхняя группа (right-toolbar.tsx:179-183).
 */
function makeToolbar({ closeButton = false, activeFirstTab = true } = {}) {
  const toolbar = node('div', { 'data-name': 'right-toolbar' });
  if (closeButton) {
    const close = node('button', { 'data-name': 'close-button' });
    close.classes.add('hash-close'); // своя тема, не наша
    toolbar.appendChild(close);
  }
  const base = node('button', {
    'data-name': 'base',
    'aria-pressed': activeFirstTab ? 'true' : 'false',
  });
  // Активное состояние — хэшированный класс на самой кнопке
  // (tool-widget-button.tsx:74-96): склонируешь такую — вкладка навсегда горит.
  if (activeFirstTab) base.classes.add('hash-active');
  toolbar.appendChild(base);
  toolbar.appendChild(node('button', { 'data-name': 'alerts', 'aria-pressed': 'false' }));
  toolbar.appendChild(node('div', { 'data-name': 'filler' }));
  toolbar.appendChild(node('button', { 'data-name': 'below-filler', 'aria-pressed': 'false' }));
  return toolbar;
}

/** Ровно тот кусок DOM, что нужен драйверу; всё остальное — null. */
function makeDocument(found = {}) {
  return {
    querySelector: (sel) => found[sel] || null,
    contains: () => true,
    createElement: () => node('span'),
  };
}

/** Полный DOM: и контейнер страниц, и тулбар. */
function makeFullDocument(toolbar = makeToolbar()) {
  const root = node('div');
  const content = node('div');
  content.classes.add('widgetbar-pagescontent');
  root.appendChild(content);
  root.appendChild(toolbar);
  const doc = {
    root,
    content,
    toolbar,
    querySelector: (sel) => {
      if (!DOCUMENT_SELECTORS.includes(sel)) throw unknownSelector(sel, DOCUMENT_SELECTORS);
      return sel === '.widgetbar-pagescontent' ? content : toolbar;
    },
    contains: (n) => root.contains(n),
    createElement: () => node('span'),
  };
  return doc;
}

/**
 * Полный документ, у которого querySelector отвечает null до вызова
 * .reveal() — то, что реально видел браузер до того, как TradingView собрал
 * виджетбар: ни .widgetbar-pagescontent, ни right-toolbar в DOM ещё нет,
 * хотя оба узла уже существуют как объекты и появятся мгновенно, как только
 * .reveal() позовут. content и toolbar доступны напрямую в обход
 * querySelector — так же, как настоящий layout.createPage() пишет в свой
 * контейнер напрямую, а не через селектор.
 */
function makeDelayedFullDocument(toolbar = makeToolbar()) {
  const full = makeFullDocument(toolbar);
  let ready = false;
  return {
    ...full,
    querySelector: (sel) => (ready ? full.querySelector(sel) : null),
    reveal: () => { ready = true; },
  };
}

/**
 * setTimeout, который не тратит настоящее время: зовёт колбэк почти сразу,
 * независимо от запрошенной задержки. Нужен только тесту на «бюджет ожидания
 * исчерпан» — драйвер честно проходит все WIDGETBAR_WAIT_ATTEMPTS попыток,
 * просто быстро.
 */
function instantTimer(fn) {
  setTimeout(fn, 0);
}

// ------------------------------------------------------------------ layout

/**
 * Страница в том виде, в каком её отдаёт хост. onActiveStateChange повторяет
 * page.ts:89-104: `ensure(this.tab)` бросает, если вкладки нет, — и именно
 * этим хост заклинивает виджетбар на чужой странице без tab.
 */
function makePage(name) {
  const page = {
    name,
    widgets: [],
    tab: undefined,
    active: false,
    el: null,
    element: () => page.el,
    onActiveStateChange(state) {
      if (!page.tab) throw new Error('Value is undefined'); // ensure(), page.ts:93
      page.tab.onActiveStateChange(!!state);
      page.active = !!state;
    },
  };
  return page;
}

/** Нативная страница приходит из demarshal — то есть уже с tab (page.ts:519). */
function makeNativePage(name) {
  const page = makePage(name);
  page.tab = { onActiveStateChange() {}, updateNotifications() {} };
  return page;
}

/**
 * Поддельный layout. switchPage и setMinimizedState ведут себя как настоящие
 * (в частности, setMinimizedState — как layout.ts:263-267 — молчит, если
 * значение не поменялось), onTabClick только помечается вызванным — драйвер
 * не должен его трогать.
 */
function makeLayout(pageCount = 3, doc = null) {
  const pages = Array.from({ length: pageCount }, (_, i) => makeNativePage(`native_${i}`));
  const L = {
    pages,
    activeIndex: 1,
    activeName: pageCount > 1 ? 'native_1' : '',
    activePageIndex: watched(1),
    isMinimized: watched(false),
    calls: [],
    // layout.ts:384-393 — страница без tab и без имени, элемент уезжает в
    // собственный контейнер лэйаута.
    createPage() {
      const page = makePage(undefined);
      page.el = doc ? doc.createElement('div') : null;
      if (doc && page.el) doc.content.appendChild(page.el);
      pages.push(page);
      L.calls.push('createPage');
      return page;
    },
    // layout.ts:280-320. Принимает и индекс, и объект страницы; для
    // отсоединённой страницы (pages.indexOf === -1) тихо ничего не делает.
    // Порядок важен: activePageIndex обновляется ДО onActiveStateChange, так
    // что подписчик видит новый индекс, пока хост ещё может бросить.
    switchPage(pageOrIndex) {
      if (pageOrIndex === -1 || pages.length === 0) {
        L.activeIndex = -1;
        L.activePageIndex.setValue(-1);
        return;
      }
      let index = pageOrIndex;
      if (typeof pageOrIndex !== 'number') {
        index = pages.indexOf(pageOrIndex);
        if (index === -1) return;
      }
      const prevPage = pages[L.activeIndex];
      L.activeIndex = Math.min(pages.length - 1, Math.max(0, index));
      L.calls.push(`switchPage:${L.activeIndex}`);
      L.activePageIndex.setValue(L.activeIndex);
      const newPage = pages[L.activeIndex];
      L.activeName = newPage.name || '';
      if (L.isMinimized.value()) return;
      if (prevPage && prevPage === newPage) return;
      if (prevPage) prevPage.onActiveStateChange(false);
      if (newPage) {
        newPage.onActiveStateChange(true);
      }
    },
    // layout.ts:263-278. Настоящий хост держит ещё и поле minimized, но с
    // watched-значением они расходятся только до первого вызова, а тест на
    // «isMinimized ещё undefined» опирается именно на watched-значение.
    setMinimizedState(v) {
      const value = !!v;
      if (L.isMinimized.value() === value) return;
      L.calls.push(`minimize:${value}`);
      L.isMinimized.setValue(value);
      if (L.activeIndex >= 0) pages[L.activeIndex].onActiveStateChange(!value);
    },
    removePage(p) {
      const i = pages.indexOf(p);
      if (i === -1) return;
      pages.splice(i, 1);
      p.element()?.remove();
      L.calls.push('removePage');
      // Хост правит только случай "удалили активную": switchPage(i-1).
      // Удаление страницы ПЕРЕД активной он не компенсирует — layout.ts:369-381.
      if (i === L.activeIndex) L.switchPage(i - 1);
    },
    onTabClick() {
      L.calls.push('onTabClick');
    },
  };
  return L;
}

function load({ layout, document: doc = makeDocument(), isAuthenticated = false, setTimeoutImpl }) {
  const posted = [];
  const listeners = {};
  mutationObservers.length = 0;
  const observers = mutationObservers;
  const win = {
    location: { origin: 'https://www.tradingview.com' },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    postMessage: (m) => posted.push(m),
    TradingViewApi: {},
    widgetbar: layout ? { layout } : undefined,
    // widgetbar-creator.ts зовёт createWidgetBar() только под этим флагом —
    // waitForWidgetBar в драйвере читает его, чтобы отличить "ещё не успел"
    // от "никогда не будет".
    is_authenticated: isAuthenticated,
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.target = null;
        this.connected = false;
        this.calls = 0;
        observers.push(this);
      }
      observe(target) {
        this.target = target;
        this.connected = true;
      }
      disconnect() {
        this.connected = false;
      }
    },
  };
  // setTimeout — отдельный параметр песочницы (а не свойство win), потому что
  // waitForWidgetBar в драйвере зовёт его голым идентификатором, а не
  // window.setTimeout. Подмена нужна только тесту на исчерпанный бюджет —
  // остальные получают настоящий таймер.
  new Function(
    'window',
    'document',
    'localStorage',
    'performance',
    'setTimeout',
    src
  )(win, doc, { getItem: () => null }, { now: () => 0 }, setTimeoutImpl || setTimeout);
  // __adopt hangs off the debug export, not HANDLERS — it must not be reachable
  // by posting a tva-req from page script.
  return {
    call: win.__tvAgent.call,
    adopt: win.__tvAgent.__adopt,
    posted,
    win,
    observers,
    fire: (type) => (listeners[type] || []).forEach((fn) => fn({})),
    listenerCount: (type) => (listeners[type] || []).length,
  };
}

/** Хендлеры синхронные, поэтому бросают синхронно — .catch() их не поймает. */
async function failure(fn) {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
}

console.log('\n— монтирование —');

{
  const { call } = load({ layout: null });
  const err = await failure(() => call('widgetbar_mount'));
  check('без window.widgetbar монтирование отказывает', /widget bar/i.test(err), true);
}

{
  // Бар и тулбар уже на месте — это проверка downstream-отказа внутри
  // wbMount, а не гонки появления бара, поэтому оба даны сразу.
  const L = makeLayout();
  const doc = makeDocument({ '[data-name="right-toolbar"]': makeToolbar() });
  const { call } = load({ layout: L, document: doc });
  const err = await failure(() => call('widgetbar_mount'));
  check('без контейнера страниц монтирование отказывает', /page container/i.test(err), true);
  check('страница не создавалась', L.calls, []);
}

{
  // hide_right_toolbar_tabs — тулбар не рендерится вовсе
  // (right-toolbar-renderer.ts:11-24) и никогда не появится: это фичесет
  // сборки, а не гонка загрузки. waitForWidgetBar не умеет — и не должен —
  // отличать такой перманентный дефицит от медленной загрузки, поэтому ждёт
  // весь бюджет и лишь потом отказывает. createPage() в этот раз не
  // вызывается вовсе (waitForWidgetBar бросает раньше layout()), так что
  // сиротской странице просто неоткуда взяться — раньше её откатывал
  // injectButton, теперь она не создаётся вовсе.
  const doc = makeFullDocument();
  doc.querySelector = (sel) => (sel === '.widgetbar-pagescontent' ? doc.content : null);
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc, isAuthenticated: true, setTimeoutImpl: instantTimer });
  const err = await failure(() => call('widgetbar_mount'));
  check('без тулбара монтирование отказывает по таймауту', /timed out/i.test(err), true);
  check('страница не создавалась вовсе', L.calls, []);
  check('элемент страницы не появился в DOM', doc.content.children.length, 0);
}

{
  // waitForWidgetBar и injectButton спрашивают один и тот же селектор дважды
  // без await между ними — сегодня их не развести, но проверка внутри
  // injectButton остаётся не просто ради вида: если её однажды разведёт
  // рефакторинг (например, вставит await между ожиданием и telecreatePage),
  // откат обязан сработать так же, как раньше срабатывал на
  // hide_right_toolbar_tabs. Подделываем именно этот зазор — тулбар есть на
  // первый запрос (готовность) и пропал на второй (injectButton).
  const doc = makeFullDocument();
  const realQuerySelector = doc.querySelector;
  let toolbarQueries = 0;
  doc.querySelector = (sel) => {
    if (sel === '[data-name="right-toolbar"]') {
      toolbarQueries++;
      return toolbarQueries === 1 ? doc.toolbar : null;
    }
    return realQuerySelector(sel);
  };
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  const err = await failure(() => call('widgetbar_mount'));
  check('тулбар пропал между готовностью и injectButton: отказ', /toolbar/i.test(err), true);
  check('страница откатилась', L.pages.length, 3);
  check('элемент страницы убран из DOM', doc.content.children.length, 0);
}

{
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  const res = await call('widgetbar_mount');
  check('монтирование отдаёт id страницы', res, { ok: true, pageId: 'tva-widgetbar-page' });
  check('страница добавлена', L.pages.length, 4);

  const page = L.pages[3];
  check('у страницы есть tab', Boolean(page.tab), true);
  // Не проверка поведения, а зафиксированное допущение: единственное, что
  // гасит вторую кнопку от _renderPages, — это ранний выход bindTabButton по
  // невидимой модели (bind-tab-button.tsx:53-57). Что кнопка и правда одна,
  // проверяется руками на живой странице, а не подделкой React.
  check(
    'допущение: tab невидим, значит второй кнопки не будет',
    [Boolean(page.tab), page.tab && page.tab.visible.value()],
    [true, false]
  );
  check(
    'tab без onClick — до onTabClick не дотянуться',
    [Boolean(page.tab), Boolean(page.tab) && page.tab.onClick.value() === undefined],
    [true, true]
  );
  check('у страницы есть имя', page.name, 'tva_agent');

  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  const filler = doc.toolbar.children.find((c) => c.tagName !== 'BUTTON');
  check('кнопка вставлена в верхнюю группу, перед filler',
    doc.toolbar.children.indexOf(btn) + 1, doc.toolbar.children.indexOf(filler));
  check('кнопка не перехватывает tab-stop тулбара', btn.attrs.tabindex, '-1');
  // base — первая button[data-name] в DOM и по умолчанию активна: клон с неё
  // унёс бы хэш активного состояния и горел бы всегда.
  check('клон не унёс хэш активной вкладки', btn.classes.has('hash-active'), false);
}

{
  // Fullscreen на адаптиве: первым в тулбаре стоит CloseButton — у него нет
  // aria-pressed (close-button.tsx), и тема у него своя.
  const doc = makeFullDocument(makeToolbar({ closeButton: true }));
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  check('CloseButton не берут за модель', btn.classes.has('hash-close'), false);
  check('и активную вкладку тоже не берут', btn.classes.has('hash-active'), false);
}

{
  // Повторное монтирование поверх живого — no-op.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  await call('widgetbar_mount');
  check('второй mount не создаёт вторую страницу', L.pages.length, 4);
  check(
    'второй mount не создаёт вторую кнопку',
    doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length,
    1
  );
}

{
  // Элемент выкинули из DOM (React перерисовал панель, слетела вёрстка) —
  // mount обязан снести остатки прежнего монтирования, а не наплодить вторую
  // страницу и вторую кнопку, которую старый observer будет возвращать.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call, observers } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  const firstButton = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  L.pages[3].el.remove(); // элемент отсоединили
  await call('widgetbar_mount');
  check('перемонтирование не оставляет вторую страницу', L.pages.length, 4);
  check(
    'перемонтирование не оставляет вторую кнопку',
    doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length,
    1
  );
  check('старая кнопка убрана из тулбара', doc.toolbar.contains(firstButton), false);
  // Старый observer держит ссылку на старую кнопку и вернул бы её в тулбар.
  check('старый observer отключён, новый подключён', observers.map((o) => o.connected), [false, true]);
}

{
  // React перерисовал список вкладок и выкинул нашу кнопку — observer обязан
  // вернуть её на место и на этом остановиться: повторный вызов колбэка видит
  // кнопку в тулбаре и больше ничего не вставляет.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call, observers } = load({ layout: L, document: doc });
  await call('widgetbar_mount');
  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  observers[0].calls = 0;
  btn.remove();
  const filler = doc.toolbar.children.find((c) => c.tagName !== 'BUTTON');
  check('кнопку вернули в тулбар', doc.toolbar.contains(btn), true);
  check('и на прежнее место, в конец верхней группы',
    doc.toolbar.children.indexOf(btn) + 1, doc.toolbar.children.indexOf(filler));
  // Удаление — раз, обратная вставка — два, и на этом всё.
  check('возврат кнопки не зацикливается', observers[0].calls, 2);
}

{
  // Выгрузка: pagehide (он, в отличие от beforeunload, работает с bfcache и
  // не выкидывает страницу из него), и вешается он только после монтирования.
  const doc = makeFullDocument();
  const L = makeLayout(3, doc);
  const { call, fire, listenerCount } = load({ layout: L, document: doc });
  check('до монтирования на выгрузку не подписаны', listenerCount('pagehide'), 0);
  check('beforeunload не используется вовсе', listenerCount('beforeunload'), 0);
  await call('widgetbar_mount');
  check('монтирование и активация проходят целиком',
    await failure(() => call('widgetbar_activate')), '');
  check('подписка на выгрузку появилась при монтировании', listenerCount('pagehide'), 1);
  fire('pagehide');
  check('на выгрузке страница уходит из layout.pages', L.pages.length, 3);
  check('и пользователя возвращают на его вкладку', L.activeIndex, 1);
}

{
  // Пользователь логинится посреди сессии. onLoginStateChange →
  // refreshFromTVSettings() (widget-bar.ts:362-407) не правит лэйаут, а сносит
  // его целиком — layout.destroy() уносит и контейнер страниц
  // (layout.ts:443-448) — и ставит на его место новый объект. Подписки на
  // activePageIndex/isMinimized обязаны переехать вместе с ним, иначе кнопка и
  // панель молча перестают узнавать о состоянии бара.
  const doc = makeFullDocument();
  const L1 = makeLayout(3, doc);
  const { call, posted, win } = load({ layout: L1, document: doc });
  await call('widgetbar_mount');
  await call('widgetbar_activate');
  check('подписки заведены на первом лэйауте',
    [L1.activePageIndex.count(), L1.isMinimized.count()], [1, 1]);

  const L2 = makeLayout(3, doc);
  // destroy() уносит весь контейнер страниц; для драйвера важно ровно одно
  // следствие — document.contains(wb.el) становится ложным и быстрый путь
  // mount'а не срабатывает. Его и воспроизводим.
  doc.content.children.slice().forEach((c) => c.remove());
  win.widgetbar.layout = L2;

  await call('widgetbar_mount');
  check('страница пересоздана в новом лэйауте', L2.pages.length, 4);
  check('подписки сняты со старого',
    [L1.activePageIndex.count(), L1.isMinimized.count()], [0, 0]);
  check('и заведены на новом',
    [L2.activePageIndex.count(), L2.isMinimized.count()], [1, 1]);

  posted.length = 0;
  L2.switchPage(3);
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('новый лэйаут снова гоняет наше состояние',
    [evt && evt.type, evt && evt.payload], ['widgetbar-active', { active: true }]);
}

console.log('\n— гонка появления бара —');

{
  // Сам баг: на живой странице window.widgetbar (а с ним .layout и тулбар)
  // появляется примерно через секунду-полторы ПОСЛЕ того, как драйвер уже
  // готов и получает первый widgetbar_mount — window.is_authenticated
  // взводится раньше, но createWidgetBar() всё равно асинхронна. Старый код
  // бросал на первом же промахе и на этом успокаивался навсегда; монтирование
  // обязано подождать и довести дело до конца.
  const doc = makeDelayedFullDocument();
  const L = makeLayout(3, doc);
  const { call, win } = load({ layout: null, document: doc, isAuthenticated: true });
  setTimeout(() => {
    doc.reveal();
    win.widgetbar = { layout: L };
  }, 350);
  const res = await call('widgetbar_mount');
  check('гонка: монтирование дожидается бара и не отказывает', res, { ok: true, pageId: 'tva-widgetbar-page' });
  check('гонка: страница создана', L.pages.length, 4);
  const btn = doc.toolbar.children.find((c) => c.attrs['data-name'] === 'tva-agent');
  check('гонка: кнопка вставлена в тулбар', Boolean(btn), true);
  check('гонка: страница доступна по id', doc.content.children.includes(L.pages[3].el), true);
}

{
  // Пока первый widgetbar_mount висит в опросе, второй (повторный boot-вызов,
  // ретрай) не должен запускать тело mount'а ещё раз — иначе оба зовут
  // createPage() независимо, и второй молча осиротит страницу, кнопку и
  // observer первого.
  const doc = makeDelayedFullDocument();
  const L = makeLayout(3, doc);
  const { call, win } = load({ layout: null, document: doc, isAuthenticated: true });
  setTimeout(() => {
    doc.reveal();
    win.widgetbar = { layout: L };
  }, 350);
  const [res1, res2] = await Promise.all([call('widgetbar_mount'), call('widgetbar_mount')]);
  check('одновременные mount: оба резолвятся одним результатом', [res1, res2], [
    { ok: true, pageId: 'tva-widgetbar-page' },
    { ok: true, pageId: 'tva-widgetbar-page' },
  ]);
  check('одновременные mount: создана только одна страница', L.pages.length, 4);
  check(
    'одновременные mount: создана только одна кнопка',
    doc.toolbar.children.filter((c) => c.attrs['data-name'] === 'tva-agent').length,
    1
  );
}

{
  // Анонимная сессия: бара не будет никогда, и это известно сразу —
  // window.is_authenticated ложный. Отказ обязан быть мгновенным, а не
  // тратить единственный бюджет ожидания на пустое опрашивание.
  const doc = makeDocument();
  const { call } = load({ layout: null, document: doc, isAuthenticated: false });
  const t0 = Date.now();
  const err = await failure(() => call('widgetbar_mount'));
  const elapsed = Date.now() - t0;
  check('не авторизован: отказ про анонимную сессию', /anonymous/i.test(err), true);
  check('не авторизован: отказ мгновенный, без опроса', elapsed < 100, true);
}

{
  // Авторизован, но бар так и не появился в пределах бюджета (например,
  // настоящий сбой хоста, а не обычная асинхронность). Сообщение обязано
  // говорить о таймауте — неверный диагноз "анонимная сессия" был бы прямой
  // ложью в адрес залогиненного пользователя.
  const doc = makeDocument();
  const { call } = load({
    layout: null,
    document: doc,
    isAuthenticated: true,
    setTimeoutImpl: instantTimer,
  });
  const err = await failure(() => call('widgetbar_mount'));
  check('таймаут: сообщение говорит именно о таймауте', /timed out/i.test(err), true);
  check('таймаут: сообщение не обвиняет анонимную сессию', /anonymous/i.test(err), false);
}

console.log('\n— активация —');

{
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  L.calls.length = 0;
  await call('widgetbar_activate');
  // Конечное состояние, не журнал вызовов — реальный setMinimizedState молчит,
  // если значение не изменилось, и журнал не всегда покажет "minimize:false".
  check('переключаемся на нашу страницу и разворачиваем', [L.activeIndex, L.isMinimized.value()], [3, false]);
  check('onTabClick не вызывался', L.calls.includes('onTabClick'), false);
  check('хост активировал нашу страницу', page.active, true);
  // switchPage пишет activeName нашей страницы (layout.ts:301), а его первый
  // же saveToTVSettings — драг делителя виджета или самого края бара —
  // унесёт в настройки аккаунта. На следующей загрузке demarshal такой
  // страницы не найдёт и сбросит вкладку пользователя на нулевую.
  check('activeName оставлен на вкладке пользователя', L.activeName, 'native_1');
}

{
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('возвращаем вкладку, что была активна', L.calls, ['switchPage:1']);
}

{
  const L = makeLayout();
  L.isMinimized.setValue(true);
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('свёрнутый бар остаётся свёрнутым', L.calls, ['switchPage:1', 'minimize:true']);
}

{
  // Разворот свёрнутого бара идёт мимо switchPage: setMinimizedState сам
  // дёргает onActiveStateChange активной страницы (layout.ts:275-277).
  const L = makeLayout();
  L.isMinimized.setValue(true);
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  const err = await failure(() => call('widgetbar_activate'));
  check('активация из свёрнутого бара не бросает', err, '');
  check('разворот активировал нашу страницу', page.active, true);
}

console.log('\n— переходы —');

{
  // Повторная активация не должна перезаписать запомненную чужую вкладку
  // нашей собственной.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  check('activate → activate → deactivate возвращает на вкладку пользователя', L.activeIndex, 1);
}

{
  // Критический случай Fix 1: TradingView сворачивает бар при перетаскивании
  // resizer'а ниже 50px (layout.ts:231-233) — это делает isActive() ложным,
  // хотя активна по-прежнему наша страница. Старый код на повторный клик по
  // нашей вкладке принимал "не активны" за чистую монету и терял вкладку
  // пользователя навсегда.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.setMinimizedState(true);
  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  check('после сворачивания и повторного клика возвращаемся к вкладке пользователя', L.activeIndex, 1);
}

{
  // Тот самый случай, который прятала подделка: как только активна наша
  // страница, ЛЮБОЙ следующий клик по нативной вкладке гонит switchPage через
  // prevPage.onActiveStateChange(false) на нас (layout.ts:310-312). Без tab
  // хост бросает на ensure() (page.ts:93), переключение не доходит, и
  // виджетбар пользователя заклинивает до перезагрузки страницы.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  const err = await failure(() => L.switchPage(0));
  check('клик по нативной вкладке после нашей не бросает', err, '');
  check('переключение доходит до конца', L.activeIndex, 0);
  check('наша страница деактивирована', page.active, false);
  check('нативная страница активирована', L.pages[0].active, true);
}

{
  // Пользователь сам ушёл на нативную вкладку, пока наша была открыта, —
  // деактивация не должна никуда его дёргать.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.switchPage(0);
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('деактивация не трогает вкладку, выбранную пользователем', L.activeIndex, 0);
  check('деактивация — no-op, если мы не активны', L.calls, []);
}

{
  // Двойная деактивация: второй вызов ничего не должен двигать.
  const L = makeLayout();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('deactivate → deactivate ничего не вызывает', L.calls, []);
  check('индекс не изменился', L.activeIndex, 1);
}

{
  // Нашу страницу выкинули из pages, пока она была активной в позиции 0 —
  // единственный случай, в котором хост реально доводит activeIndex до -1
  // (switchPage(i - 1) при i === 0, layout.ts:379-381). activate должен
  // отказать, а state не должен путать "нас нет" (-1) с "активной страницы
  // нет" (тоже -1) и объявлять себя активным.
  const L = makeLayout(0);
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  L.removePage(page);
  const err = await failure(() => call('widgetbar_activate'));
  check('активация без страницы в pages отказывает', /not mounted/i.test(err), true);
  check('state не путает -1 с -1', await call('widgetbar_state'), { active: false, minimized: false });
}

console.log('\n— состояние —');

{
  const L = makeLayout();
  const { call, adopt, posted } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('активация шлёт событие', [evt.type, evt.payload], ['widgetbar-active', { active: true }]);
  check('состояние читается', await call('widgetbar_state'), {
    active: true,
    minimized: false,
  });
}

{
  const L = makeLayout();
  const { call, adopt, posted } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  posted.length = 0;
  L.switchPage(0);
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('чужая вкладка гасит нашу', [evt.type, evt.payload], ['widgetbar-active', { active: false }]);
}

{
  // De-dupe: повторное уведомление о том же значении не должно слать второе
  // событие.
  const L = makeLayout();
  const { call, adopt, posted } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  await call('widgetbar_activate');
  posted.length = 0;
  L.switchPage(0);
  L.switchPage(2);
  check('повтор того же active=false не дублирует событие', posted.filter((m) => m.source === 'tva-evt').length, 1);
}

{
  // Настоящий layout.isMinimized рождается без значения — new WatchedValue()
  // (layout.ts:65) — и остаётся undefined, пока syncWidth ничего не выставил.
  // widgetbar_state и захват prevMinimized обязаны привести undefined к
  // false, а не протащить его дальше.
  const L = makeLayout();
  L.isMinimized = watched();
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);

  check('minimized === undefined читается как false', (await call('widgetbar_state')).minimized, false);

  await call('widgetbar_activate');
  await call('widgetbar_deactivate');
  check('prevMinimized из undefined не пытается свернуть бар обратно', L.calls.includes('minimize:true'), false);
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
