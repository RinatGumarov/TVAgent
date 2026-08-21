/**
 * TVAgent — panel.css invariants: theme and composer geometry.
 *
 * The panel used to key off prefers-color-scheme, so on a dark TradingView
 * under a light macOS it came out white. This checks that every panel variable
 * is bound to a TradingView token and that the media query is gone.
 *
 * The second half is the composer's flex geometry. Both rules look optional
 * right up until the content stops fitting: without them the send button
 * squashed into an oval and the chips refused to shorten, pushing it past the
 * edge of the field. They are guarded here because they are CSS properties
 * with no behaviour in panel.js behind them, so panel-test.mjs cannot see them.
 *
 *   node theme-test.mjs
 */
import fs from 'node:fs';
import { check, section, report } from './helpers/check.mjs';

const css = fs.readFileSync(
  new URL('../extension/src/content/panel.css', import.meta.url).pathname,
  'utf8'
);

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

section('bound to TradingView tokens');

for (const [ours, theirs] of Object.entries(BINDINGS)) {
  const line = css.split('\n').find((l) => l.trim().startsWith(`${ours}:`));
  check(`${ours} → ${theirs}`, !!line && line.includes(`var(${theirs},`), true);
}

section('the host’s theme, not the system’s');

check('prefers-color-scheme is gone', /prefers-color-scheme/.test(css), false);
check("TradingView's font", /font-family:[^;]*"Trebuchet MS"[^;]*Roboto/.test(css), true);

section('composer geometry');

/** The body of one rule by exact selector — the file is flat, no nesting. */
function ruleBody(selector) {
  const re = new RegExp(`${selector.replace(/[.#*]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  return (css.replace(/\/\*[\s\S]*?\*\//g, '').match(re) || [])[1] || '';
}

// A 26×26 circle with the default flex-shrink squashed into an oval the
// moment the chips stopped fitting on their row.
check(
  'the send button does not shrink',
  /flex:\s*0\s+0\s+auto/.test(ruleBody('#tva-root .tva-send')),
  true
);

// min-width on a flex item defaults to auto, meaning never smaller than the
// content: without an explicit zero, text-overflow never happens and a long
// model name stretches the row instead of being clipped.
const chip = ruleBody('#tva-root .tva-chip');
check('a chip can shorten (min-width: 0)', /min-width:\s*0/.test(chip), true);
check('and is clipped with an ellipsis', /text-overflow:\s*ellipsis/.test(chip), true);

section('the API key fields');

// The key inputs live in closed shadow roots, so the panel's own stylesheet
// cannot reach them and their styling ships inside panel-settings.js. What
// stays here is the box they sit in — without it the host element is inline
// and the field collapses.
check('the shadow host is a block', /\.tva-secret\s*\{[^}]*display:\s*block/.test(css), true);

report();
