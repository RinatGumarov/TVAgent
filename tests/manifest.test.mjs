/** Manifest invariants Chrome enforces silently. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'static/manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entries = manifest.content_scripts || [];

const world = (name) =>
  entries.filter((e) => (e.world || 'ISOLATED') === name).flatMap((e) => e.js || []);

const runAt = (file) => entries.find((e) => (e.js || []).includes(file))?.run_at;

describe('the two worlds get their own bundle', () => {
  it('the driver is the MAIN world bundle', () => {
    assert.deepStrictEqual(world('MAIN'), ['driver.js']);
  });

  it('the bridge and the panel are the ISOLATED world bundles', () => {
    assert.deepStrictEqual(world('ISOLATED'), ['bridge.js', 'panel.js']);
  });

  // Both ends have to be up before the page's first script, or the handshake
  // is racing the scripts it was designed to exclude.
  it('the driver is up at document_start', () => {
    assert.deepStrictEqual(runAt('driver.js'), 'document_start');
  });

  it('the bridge is up at document_start', () => {
    assert.deepStrictEqual(runAt('bridge.js'), 'document_start');
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

describe('the manifest and the package agree', () => {
  it('one version, not two', () => {
    assert.deepStrictEqual(manifest.version, pkg.version);
  });
});
