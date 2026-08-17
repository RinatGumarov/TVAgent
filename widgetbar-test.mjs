/**
 * TVAgent — страница в виджетбаре TradingView.
 *
 * Гоняет настоящий driver.js против поддельного window.widgetbar. Проверяет то,
 * что дорого сломать: активация не должна ходить через onTabClick (он пишет наш
 * лист в настройки аккаунта), а закрытие — возвращать ту вкладку, что была.
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

/** Наблюдаемое значение с тем же интерфейсом, что у TradingView. */
function watched(value) {
  const subs = [];
  return {
    value: () => value,
    setValue: (v) => {
      value = v;
      subs.forEach((fn) => fn(v));
    },
    subscribe: (fn) => subs.push(fn),
    unsubscribe: () => {},
  };
}

/**
 * Поддельный layout. switchPage и setMinimizedState ведут себя как настоящие;
 * onTabClick только помечается вызванным — драйвер не должен его трогать.
 */
function makeLayout(pageCount = 3) {
  const pages = Array.from({ length: pageCount }, (_, i) => ({ name: `native_${i}` }));
  const L = {
    pages,
    activeIndex: 1,
    activePageIndex: watched(1),
    isMinimized: watched(false),
    calls: [],
    createPage() {
      const page = { name: undefined, widgets: [] };
      pages.push(page);
      L.calls.push('createPage');
      return page;
    },
    switchPage(i) {
      L.calls.push(`switchPage:${i}`);
      L.activeIndex = i;
      L.activePageIndex.setValue(i);
    },
    setMinimizedState(v) {
      L.calls.push(`minimize:${v}`);
      L.isMinimized.setValue(!!v);
    },
    removePage(p) {
      L.calls.push('removePage');
      pages.splice(pages.indexOf(p), 1);
    },
    onTabClick() {
      L.calls.push('onTabClick');
    },
  };
  return L;
}

/** Ровно тот кусок DOM, что нужен драйверу; всё остальное — null. */
function makeDocument(found = {}) {
  return {
    querySelector: (sel) => found[sel] || null,
    contains: () => true,
    createElement: () => ({
      className: '',
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      setAttribute() {},
    }),
  };
}

function load({ layout, document: doc = makeDocument() }) {
  const posted = [];
  const win = {
    location: { origin: 'https://www.tradingview.com' },
    addEventListener: () => {},
    postMessage: (m) => posted.push(m),
    TradingViewApi: {},
    widgetbar: layout ? { layout } : undefined,
  };
  new Function(
    'window',
    'document',
    'localStorage',
    'performance',
    src
  )(win, doc, { getItem: () => null }, { now: () => 0 });
  return { call: win.__tvAgent.call, posted, win };
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
  const L = makeLayout();
  const { call } = load({ layout: L, document: makeDocument() });
  const err = await failure(() => call('widgetbar_mount'));
  check('без контейнера страниц монтирование отказывает', /page container/i.test(err), true);
}

console.log('\n— активация —');

{
  const L = makeLayout();
  const { call } = load({ layout: L });
  const page = L.createPage();
  L.calls.length = 0;
  call('__test_adopt', { page });
  await call('widgetbar_activate');
  check('переключаемся на нашу страницу и разворачиваем', L.calls, ['switchPage:3', 'minimize:false']);
  check('onTabClick не вызывался', L.calls.includes('onTabClick'), false);
}

{
  const L = makeLayout();
  const { call } = load({ layout: L });
  const page = L.createPage();
  call('__test_adopt', { page });
  await call('widgetbar_activate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('возвращаем вкладку, что была активна', L.calls, ['switchPage:1']);
}

{
  const L = makeLayout();
  L.isMinimized.setValue(true);
  const { call } = load({ layout: L });
  const page = L.createPage();
  call('__test_adopt', { page });
  await call('widgetbar_activate');
  L.calls.length = 0;
  await call('widgetbar_deactivate');
  check('свёрнутый бар остаётся свёрнутым', L.calls, ['switchPage:1', 'minimize:true']);
}

console.log('\n— состояние —');

{
  const L = makeLayout();
  const { call, posted } = load({ layout: L });
  const page = L.createPage();
  call('__test_adopt', { page });
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
  const { call, posted } = load({ layout: L });
  const page = L.createPage();
  call('__test_adopt', { page });
  await call('widgetbar_activate');
  posted.length = 0;
  L.switchPage(0);
  const evt = posted.filter((m) => m.source === 'tva-evt').pop();
  check('чужая вкладка гасит нашу', [evt.type, evt.payload], ['widgetbar-active', { active: false }]);
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
