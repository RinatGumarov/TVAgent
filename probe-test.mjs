/**
 * TVAgent — стартовая проба чарта.
 *
 * Настоящие driver.js и bridge.js на поддельном window: TradingView отвечает
 * не сразу, и первые обращения к resolution() падают с «Value is null» — ровно
 * как на живой странице, пока чарт грузится. Проба обязана дождаться, а не
 * отдать полупустой отчёт, из которого панель печатает «· null».
 *
 *   node probe-test.mjs
 */
import fs from 'node:fs';

const EXT = new URL('./extension/src/', import.meta.url).pathname;
const ORIGIN = 'https://www.tradingview.com';

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${name}${ok ? '' : `\n        получили ${JSON.stringify(got)}\n        ждали    ${JSON.stringify(want)}`}`);
}

/** window, в котором postMessage реально доставляет сообщение слушателям. */
function makeWindow(tradingViewApi) {
  const listeners = [];
  const win = {
    location: { origin: ORIGIN },
    user: { id: 42 },
    TradingViewApi: tradingViewApi,
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) {
      queueMicrotask(() => {
        for (const fn of listeners) fn({ data, source: win, origin: ORIGIN });
      });
    },
  };
  return win;
}

/**
 * Чарт, который «просыпается» не сразу: symbol() отвечает с самого начала, а
 * resolution() первые `flaky` раз бросает то же, что бросает живой TradingView.
 *
 * bars() — настоящая форма, которой реально пользуется driver.js для цены
 * (last().value — шестиэлементный [time, open, high, low, close, volume],
 * close на индексе 4), а не голая заглушка isEmpty() — раньше её отсутствие
 * маскировалось тем, что ни один check() не смотрел на report.series/price,
 * и ловилось бы молча неверным report.series после того, как проба стала
 * читать цену тем же bars()-объектом.
 *
 * hasBars: false — бары ещё не загружены (isEmpty() → true), это и есть
 * штатный случай "отчёт готов, но цены ещё нет" — не ошибка.
 * lastThrows: true — last() бросает, хотя isEmpty() уже сказал false; это не
 * реалистичный сценарий живого TradingView, но именно та защита, которую
 * попросили: провал чтения цены не должен откатывать уже корректно
 * вычисленный report.series обратно на false.
 */
function makeChart(flaky, { lastClose = 65432.1, hasBars = true, lastThrows = false } = {})  {
  let calls = 0;
  const bars = {
    isEmpty: () => !hasBars,
    last: () => {
      if (lastThrows) throw new Error('last() blew up');
      // time, open, high, low, close, volume — close — индекс 4, ровно тот,
      // что читает driver.js.
      return { value: [1700000000, lastClose - 12, lastClose + 20, lastClose - 30, lastClose, 1234] };
    },
  };
  const series = { data: () => ({ bars: () => bars }) };
  return {
    activeChart: () => ({
      symbol: () => 'BINGX:BTCUSDT.P',
      resolution: () => {
        if (++calls <= flaky) throw new Error('Value is null');
        return '60';
      },
      getSeries: () => series,
      createStudy() {}, getAllStudies: () => [], createShape() {}, getStudyById() {},
      studyMetaIntoRepository: () => null,
    }),
    pineEditorTestApi: () => ({}),
  };
}

function boot(flaky, chartOpts) {
  const win = makeWindow(makeChart(flaky, chartOpts));
  const localStorage = { getItem: () => null };
  for (const file of ['injected/driver.js', 'content/bridge.js']) {
    new Function('window', 'localStorage', fs.readFileSync(`${EXT}${file}`, 'utf8'))(win, localStorage);
  }
  return win;
}

console.log('\n— чарт отвечает не сразу —');
{
  const win = boot(2);
  const report = await win.TVAgentBridge.probeWhenReady();
  check('symbol прочитан', report.symbol, 'BINGX:BTCUSDT.P');
  check('resolution дождались, а не null', report.resolution, '60');
  check('отчёт помечен готовым', report.ready, true);
  check('без предупреждения «Chart not ready»', (report.warnings || []).filter((w) => /Chart not ready/.test(w)), []);
}

console.log('\n— чарт так и не ответил —');
{
  const win = boot(Infinity);
  const report = await win.TVAgentBridge.probeWhenReady(2);
  check('отчёт не готов', !report.ready, true);
  check('но чарт найден — панель не должна ругаться на «нет API»', [report.tradingViewApi, report.chart], [true, true]);
  check('предупреждение на месте', (report.warnings || []).some((w) => /Chart not ready/.test(w)), true);
  check('price отсутствует — до бар вообще не дошли', 'price' in report, false);
}

console.log('\n— цена в отчёте —');
{
  const win = boot(0, { lastClose: 65432.1 });
  const report = await win.TVAgentBridge.probeWhenReady();
  check('series = true (бары загружены)', report.series, true);
  check('price — последний close', report.price, 65432.1);
}

console.log('\n— бары ещё не загружены: price отсутствует, а не null —');
{
  const win = boot(0, { hasBars: false });
  const report = await win.TVAgentBridge.probeWhenReady();
  check('series = false', report.series, false);
  check('price отсутствует как ключ (не просто undefined)', 'price' in report, false);
}

console.log('\n— чтение цены падает: series не откатывается вслед за ним —');
{
  // isEmpty() уже сказал false (бары загружены), но last() всё равно бросает.
  // Раньше это был один try/catch на оба поля — провал last() откатывал уже
  // верно вычисленный report.series обратно на false. Цена и флаг теперь
  // защищены раздельно.
  const win = boot(0, { lastThrows: true });
  const report = await win.TVAgentBridge.probeWhenReady();
  check('series остаётся true, несмотря на провал чтения цены', report.series, true);
  check('price отсутствует, проба не упала целиком', 'price' in report, false);
  check('отчёт всё равно готов', report.ready, true);
}

console.log(failed ? `\n ПРОВАЛЕНО: ${failed}\n` : '\n всё зелёное\n');
process.exit(failed ? 1 : 0);
