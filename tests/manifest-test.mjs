/**
 * Manifest invariants Chrome enforces silently: every listed file exists, no
 * file is claimed by two worlds, and the page world's copies of the shared
 * modules match their source.
 */
import fs from 'node:fs';
import { check, section, report } from './helpers/check.mjs';

const EXT = new URL('../extension/', import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(EXT + 'manifest.json', 'utf8'));
const entries = manifest.content_scripts || [];

/**
 * The MAIN world's copies of the shared modules: one authored file, one copy
 * per world.
 */
const MIRRORS = [
  ['src/shared/wire.js', 'src/injected/wire.js'],
  ['src/shared/wait.js', 'src/injected/wait.js'],
];

section('every declared file exists');

{
  const declared = entries.flatMap((e) => [...(e.js || []), ...(e.css || [])]);
  const missing = declared.filter((rel) => !fs.existsSync(EXT + rel));
  check('no content script points at a file that is not there', missing, []);
}

section('no file is claimed by two entries');

{
  const seen = new Map();
  for (const entry of entries) {
    for (const rel of entry.js || []) {
      seen.set(rel, (seen.get(rel) || 0) + 1);
    }
  }
  const shared = [...seen.entries()].filter(([, n]) => n > 1).map(([rel]) => rel);
  check('each script file is listed exactly once', shared, []);
}

section('the worlds that share code have their own copy of it');

{
  for (const [origin, copy] of MIRRORS) {
    const there = fs.existsSync(EXT + copy);
    check(`${copy} exists`, there, true);
    if (!there) continue;
    // Byte equality: wire.js is the authentication, and a copy that has
    // drifted fails as a handshake that never completes.
    check(
      `${copy} is byte-identical to ${origin}`,
      fs.readFileSync(EXT + copy, 'utf8') === fs.readFileSync(EXT + origin, 'utf8'),
      true,
    );
  }
}

section('the two worlds still get what they need');

{
  const world = (name) =>
    entries.filter((e) => (e.world || 'ISOLATED') === name).flatMap((e) => e.js || []);

  const main = world('MAIN');
  const isolated = world('ISOLATED');

  // driver.js and bridge.js read the wire at load, so it has to be ahead of
  // them in the same entry.
  const ahead = (rel, dependency) => {
    const entry = entries.find((e) => (e.js || []).includes(rel));
    const js = entry ? entry.js : [];
    return js.indexOf(dependency) !== -1 && js.indexOf(dependency) < js.indexOf(rel);
  };

  check('driver.js is in the MAIN world', main.includes('src/injected/driver.js'), true);
  check('bridge.js is in the ISOLATED world', isolated.includes('src/content/bridge.js'), true);
  check(
    'driver.js loads after its wire',
    ahead('src/injected/driver.js', 'src/injected/wire.js'),
    true,
  );
  check(
    'driver.js loads after its wait',
    ahead('src/injected/driver.js', 'src/injected/wait.js'),
    true,
  );
  check(
    'bridge.js loads after its wire',
    ahead('src/content/bridge.js', 'src/shared/wire.js'),
    true,
  );

  // Both ends have to be up before the page's first script, or the handshake
  // is racing scripts it was designed to exclude.
  const startsEarly = (rel) =>
    entries.find((e) => (e.js || []).includes(rel))?.run_at === 'document_start';
  check('the driver is up at document_start', startsEarly('src/injected/driver.js'), true);
  check('the bridge is up at document_start', startsEarly('src/content/bridge.js'), true);
}

section('store permissions stay narrow');

{
  check(
    'the declared Chrome floor matches MAIN-world content scripts',
    manifest.minimum_chrome_version,
    '111',
  );
  check(
    'only the selected built-in provider is granted at install time',
    manifest.host_permissions,
    ['https://api.anthropic.com/*'],
  );
  check('user-selected providers are runtime permissions', manifest.optional_host_permissions, [
    'http://localhost/*',
    'http://127.0.0.1/*',
    'https://*/*',
  ]);
}

report();
