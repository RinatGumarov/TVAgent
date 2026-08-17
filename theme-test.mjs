/**
 * TVAgent — тема панели.
 *
 * Панель раньше кейилась на prefers-color-scheme, поэтому на тёмном
 * TradingView со светлой macOS была белой. Проверяет, что каждая переменная
 * панели привязана к токену TradingView и что медиазапроса больше нет.
 *
 *   node theme-test.mjs
 */
import fs from 'node:fs';

const css = fs.readFileSync(
  new URL('./extension/src/content/panel.css', import.meta.url).pathname,
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

const BINDINGS = {
  '--tva-bg': '--color-background-primary',
  '--tva-bg-soft': '--color-background-secondary',
  '--tva-fg': '--color-text-primary',
  '--tva-fg-dim': '--color-text-secondary',
  '--tva-border': '--color-divider',
  '--tva-accent': '--color-tv-blue-500',
  '--tva-accent-tint': '--color-background-special-secondary',
  '--tva-ok': '--color-static-success',
  '--tva-err': '--color-static-danger',
  '--tva-warn': '--color-static-warning',
};

console.log('\n— привязка к токенам TradingView —');

for (const [ours, theirs] of Object.entries(BINDINGS)) {
  const line = css.split('\n').find((l) => l.trim().startsWith(`${ours}:`));
  check(`${ours} → ${theirs}`, !!line && line.includes(`var(${theirs},`), true);
}

console.log('\n— тема хоста, не системы —');

check('prefers-color-scheme убран', /prefers-color-scheme/.test(css), false);
check(
  'шрифт TradingView',
  /font-family:[^;]*"Trebuchet MS"[^;]*Roboto/.test(css),
  true
);

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
