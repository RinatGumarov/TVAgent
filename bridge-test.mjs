/**
 * TVAgent — мост: односторонний канал событий из драйвера.
 *
 * Гоняет настоящий bridge.js под поддельным window. Проверяет то, что легко
 * сломать: чужой origin, чужой source и подписка на несколько обработчиков.
 *
 *   node bridge-test.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(
  new URL('./extension/src/content/bridge.js', import.meta.url).pathname,
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

/** Поддельное окно: копит слушателей и умеет доставлять событие message. */
function makeWindow() {
  const listeners = [];
  const win = {
    location: { origin: 'https://www.tradingview.com' },
    listeners,
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    postMessage: () => {},
    deliver: (data, origin = 'https://www.tradingview.com') =>
      listeners.forEach((fn) => fn({ source: win, origin, data })),
  };
  return win;
}

const load = (win) =>
  new Function('window', 'setTimeout', 'clearTimeout', `${src}\nreturn window.TVAgentBridge;`)(
    win,
    () => 0,
    () => {}
  );

console.log('\n— канал событий —');

{
  const win = makeWindow();
  const bridge = load(win);
  const seen = [];
  bridge.on('widgetbar-active', (p) => seen.push(p));
  win.deliver({ source: 'tva-evt', type: 'widgetbar-active', payload: { active: true } });
  check('событие доходит до обработчика', seen, [{ active: true }]);
}

{
  const win = makeWindow();
  const bridge = load(win);
  const seen = [];
  bridge.on('widgetbar-active', (p) => seen.push(p));
  win.deliver(
    { source: 'tva-evt', type: 'widgetbar-active', payload: { active: true } },
    'https://evil.example'
  );
  check('чужой origin отбрасывается', seen, []);
}

{
  const win = makeWindow();
  const bridge = load(win);
  const seen = [];
  bridge.on('widgetbar-active', (p) => seen.push(p));
  win.deliver({ source: 'tva-res', type: 'widgetbar-active', payload: { active: true } });
  check('чужой source отбрасывается', seen, []);
}

{
  const win = makeWindow();
  const bridge = load(win);
  const seen = [];
  bridge.on('widgetbar-active', () => seen.push('a'));
  bridge.on('widgetbar-active', () => seen.push('b'));
  bridge.on('other', () => seen.push('c'));
  win.deliver({ source: 'tva-evt', type: 'widgetbar-active', payload: {} });
  check('оба обработчика одного типа вызваны, чужой — нет', seen, ['a', 'b']);
}

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
