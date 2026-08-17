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
 */
function makeChart(flaky) {
  let calls = 0;
  const series = { data: () => ({ bars: () => ({ isEmpty: () => false }) }) };
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

function boot(flaky) {
  const win = makeWindow(makeChart(flaky));
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
}

console.log(failed ? `\n ПРОВАЛЕНО: ${failed}\n` : '\n всё зелёное\n');
process.exit(failed ? 1 : 0);
