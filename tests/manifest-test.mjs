/**
 * TVAgent — the manifest invariants Chrome enforces silently.
 *
 * Chrome injects a given script file into a document once per extension. When
 * the same path is listed in two content_scripts entries, the first entry wins
 * and takes the file's world with it — the second entry is served the file it
 * asked for only if no earlier entry already claimed it, and there is no error
 * anywhere when it doesn't.
 *
 * That is how shared/wire.js came to be loaded into the MAIN world and not the
 * ISOLATED one, while both entries listed it: bridge.js threw on `wire.id()`
 * at document_start, TVAgentBridge was never assigned, and the panel came up
 * with "failed to start: Cannot read properties of undefined". Nothing in the
 * manifest looked wrong, and the tests were all green, because the file that
 * broke it is only broken when Chrome loads it.
 *
 * So the rule is: a file belongs to exactly one entry. A world that needs the
 * same code needs its own copy of it, and the copies are compared here.
 *
 *   node manifest-test.mjs
 */
import fs from 'node:fs';
import { check, section, report } from './helpers/check.mjs';

const EXT = new URL('../extension/', import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(EXT + 'manifest.json', 'utf8'));
const entries = manifest.content_scripts || [];

/**
 * The MAIN world's copies of the shared modules. One authored file, one copy
 * per world, because the manifest cannot name the same file twice.
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
  // The bug this whole file exists for. Counted across entries rather than
  // within one, because a repeat inside a single entry is merely redundant —
  // it is the second *entry* that loses its copy, and its world with it.
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
    // Byte equality, not "close enough": wire.js is the authentication, and a
    // copy that has drifted from it fails as a handshake that never completes.
    check(
      `${copy} is byte-identical to ${origin}`,
      fs.readFileSync(EXT + copy, 'utf8') === fs.readFileSync(EXT + origin, 'utf8'),
      true
    );
  }
}

section('the two worlds still get what they need');

{
  const world = (name) =>
    entries.filter((e) => (e.world || 'ISOLATED') === name).flatMap((e) => e.js || []);

  const main = world('MAIN');
  const isolated = world('ISOLATED');

  // driver.js reads TVAgentWire and TVAgentWait at load; bridge.js reads
  // TVAgentWire at load. Whichever copy they get, it has to be in their world
  // and ahead of them in the same entry.
  const ahead = (rel, dependency) => {
    const entry = entries.find((e) => (e.js || []).includes(rel));
    const js = entry ? entry.js : [];
    return js.indexOf(dependency) !== -1 && js.indexOf(dependency) < js.indexOf(rel);
  };

  check('driver.js is in the MAIN world', main.includes('src/injected/driver.js'), true);
  check('bridge.js is in the ISOLATED world', isolated.includes('src/content/bridge.js'), true);
  check('driver.js loads after its wire', ahead('src/injected/driver.js', 'src/injected/wire.js'), true);
  check('driver.js loads after its wait', ahead('src/injected/driver.js', 'src/injected/wait.js'), true);
  check('bridge.js loads after its wire', ahead('src/content/bridge.js', 'src/shared/wire.js'), true);

  // Both ends have to be up before the page's first script, or the handshake
  // in wire.js is racing scripts it was designed to exclude.
  const startsEarly = (rel) =>
    entries.find((e) => (e.js || []).includes(rel))?.run_at === 'document_start';
  check('the driver is up at document_start', startsEarly('src/injected/driver.js'), true);
  check('the bridge is up at document_start', startsEarly('src/content/bridge.js'), true);
}

report();
