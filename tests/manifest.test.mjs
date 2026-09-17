/**
 * Manifest invariants Chrome enforces silently: every listed file exists, no
 * file is claimed by two worlds, and the page world's copies of the shared
 * modules match their source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

describe('every declared file exists', () => {
  it('no content script points at a file that is not there', () => {
    const declared = entries.flatMap((e) => [...(e.js || []), ...(e.css || [])]);
    assert.deepStrictEqual(
      declared.filter((rel) => !fs.existsSync(EXT + rel)),
      [],
    );
  });
});

describe('no file is claimed by two entries', () => {
  it('each script file is listed exactly once', () => {
    const seen = new Map();
    for (const entry of entries) {
      for (const rel of entry.js || []) seen.set(rel, (seen.get(rel) || 0) + 1);
    }
    assert.deepStrictEqual(
      [...seen.entries()].filter(([, n]) => n > 1).map(([rel]) => rel),
      [],
    );
  });
});

describe('the worlds that share code have their own copy of it', () => {
  for (const [origin, copy] of MIRRORS) {
    it(`${copy} exists`, () => {
      assert.ok(fs.existsSync(EXT + copy));
    });

    // Byte equality: wire.js is the authentication, and a copy that has
    // drifted fails as a handshake that never completes.
    it(`${copy} is byte-identical to ${origin}`, () => {
      assert.deepStrictEqual(
        fs.readFileSync(EXT + copy, 'utf8'),
        fs.readFileSync(EXT + origin, 'utf8'),
      );
    });
  }
});

describe('the two worlds still get what they need', () => {
  const world = (name) =>
    entries.filter((e) => (e.world || 'ISOLATED') === name).flatMap((e) => e.js || []);

  // driver.js and bridge.js read the wire at load, so it has to be ahead of
  // them in the same entry.
  const ahead = (rel, dependency) => {
    const entry = entries.find((e) => (e.js || []).includes(rel));
    const js = entry ? entry.js : [];
    return js.indexOf(dependency) !== -1 && js.indexOf(dependency) < js.indexOf(rel);
  };

  // Both ends have to be up before the page's first script, or the handshake
  // is racing scripts it was designed to exclude.
  const startsEarly = (rel) =>
    entries.find((e) => (e.js || []).includes(rel))?.run_at === 'document_start';

  it('driver.js is in the MAIN world', () => {
    assert.ok(world('MAIN').includes('src/injected/driver.js'));
  });

  it('bridge.js is in the ISOLATED world', () => {
    assert.ok(world('ISOLATED').includes('src/content/bridge.js'));
  });

  it('driver.js loads after its wire', () => {
    assert.ok(ahead('src/injected/driver.js', 'src/injected/wire.js'));
  });

  it('driver.js loads after its wait', () => {
    assert.ok(ahead('src/injected/driver.js', 'src/injected/wait.js'));
  });

  it('bridge.js loads after its wire', () => {
    assert.ok(ahead('src/content/bridge.js', 'src/shared/wire.js'));
  });

  it('the driver is up at document_start', () => {
    assert.ok(startsEarly('src/injected/driver.js'));
  });

  it('the bridge is up at document_start', () => {
    assert.ok(startsEarly('src/content/bridge.js'));
  });
});

describe('store permissions stay narrow', () => {
  it('the declared Chrome floor matches MAIN-world content scripts', () => {
    assert.deepStrictEqual(manifest.minimum_chrome_version, '111');
  });

  it('only the selected built-in provider is granted at install time', () => {
    assert.deepStrictEqual(manifest.host_permissions, ['https://api.anthropic.com/*']);
  });

  it('user-selected providers are runtime permissions', () => {
    assert.deepStrictEqual(manifest.optional_host_permissions, [
      'http://localhost/*',
      'http://127.0.0.1/*',
      'https://*/*',
    ]);
  });
});
