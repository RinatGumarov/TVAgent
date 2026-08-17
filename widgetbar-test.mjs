/**
 * TVAgent — страница в виджетбаре TradingView.
 *
 * Гоняет настоящий driver.js против поддельного window.widgetbar. Проверяет то,
 * что дорого сломать: активация не должна ходить через onTabClick (он пишет наш
 * лист в настройки аккаунта), закрытие — возвращать ту вкладку, что была, а не
 * дёргать пользователя, если он сам ушёл на другую вкладку, и хранит для этого
 * саму страницу, а не индекс, который сдвигается при удалении чужих страниц.
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
      subs.forEach((fn) => fn(v));
    },
    subscribe: (fn) => subs.push(fn),
    unsubscribe: () => {},
  };
}

/**
 * Поддельный layout. switchPage и setMinimizedState ведут себя как настоящие
 * (в частности, setMinimizedState — как layout.ts:263-267 — молчит, если
 * значение не поменялось), onTabClick только помечается вызванным — драйвер
 * не должен его трогать.
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
    // Реальный switchPage принимает и индекс, и объект страницы; для
    // отсоединённой страницы (pages.indexOf === -1) тихо ничего не делает —
    // layout.ts:287-292.
    switchPage(pageOrIndex) {
      let i = pageOrIndex;
      if (typeof pageOrIndex !== 'number') {
        i = pages.indexOf(pageOrIndex);
        if (i === -1) return;
      }
      L.calls.push(`switchPage:${i}`);
      L.activeIndex = i;
      L.activePageIndex.setValue(i);
    },
    setMinimizedState(v) {
      const nv = !!v;
      if (L.isMinimized.value() === nv) return;
      L.calls.push(`minimize:${nv}`);
      L.isMinimized.setValue(nv);
    },
    removePage(p) {
      const i = pages.indexOf(p);
      if (i === -1) return;
      pages.splice(i, 1);
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
  // __adopt hangs off the debug export, not HANDLERS — it must not be reachable
  // by posting a tva-req from page script.
  return { call: win.__tvAgent.call, adopt: win.__tvAgent.__adopt, posted, win };
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
  const { call, adopt } = load({ layout: L });
  const page = L.createPage();
  adopt(page);
  L.calls.length = 0;
  await call('widgetbar_activate');
  // Конечное состояние, не журнал вызовов — реальный setMinimizedState молчит,
  // если значение не изменилось, и журнал не всегда покажет "minimize:false".
  check('переключаемся на нашу страницу и разворачиваем', [L.activeIndex, L.isMinimized.value()], [3, false]);
  check('onTabClick не вызывался', L.calls.includes('onTabClick'), false);
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
