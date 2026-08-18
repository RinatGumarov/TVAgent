/**
 * TVAgent — инварианты panel.css: тема и геометрия композера.
 *
 * Панель раньше кейилась на prefers-color-scheme, поэтому на тёмном
 * TradingView со светлой macOS была белой. Проверяет, что каждая переменная
 * панели привязана к токену TradingView и что медиазапроса больше нет.
 *
 * Вторая половина — про flex-геометрию композера. Оба правила выглядят
 * необязательными ровно до того момента, когда содержимое перестаёт влезать:
 * без них кнопка отправки сплющивалась в овал, а чипы отказывались
 * укорачиваться и выдавливали её за край поля. Здесь их и стережём — это
 * свойства CSS, поведения в panel.js за ними нет, так что panel-test.mjs их
 * увидеть не может.
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

console.log('\n— геометрия композера —');

/** Тело правила по точному селектору (файл плоский — вложенности нет). */
function ruleBody(selector) {
  const re = new RegExp(`${selector.replace(/[.#*]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  return (css.replace(/\/\*[\s\S]*?\*\//g, '').match(re) || [])[1] || '';
}

// Круг 26×26 с flex-shrink по умолчанию сжимался в овал, как только чипы
// переставали влезать в свой ряд.
check(
  'кнопка отправки не сжимается',
  /flex:\s*0\s+0\s+auto/.test(ruleBody('#tva-root .tva-send')),
  true
);

// min-width у flex-элемента по умолчанию auto, то есть не меньше содержимого:
// без явного нуля text-overflow не наступает никогда, и длинное имя модели
// распирает ряд вместо того, чтобы обрезаться.
const chip = ruleBody('#tva-root .tva-chip');
check('чип может укоротиться (min-width: 0)', /min-width:\s*0/.test(chip), true);
check('и обрезается многоточием', /text-overflow:\s*ellipsis/.test(chip), true);

console.log(failed ? `\n${failed} провалов\n` : '\nвсё зелёное\n');
process.exit(failed ? 1 : 0);
