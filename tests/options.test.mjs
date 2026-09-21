/** Runs the options page's key form under the fake DOM. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDocument, click } from './helpers/dom.mjs';
import { loadModule } from './helpers/load.mjs';

async function open(store) {
  const doc = makeDocument();
  const page = doc.createElement('div');
  const html = fs.readFileSync(new URL('../static/options.html', import.meta.url), 'utf8');
  page.innerHTML = html.slice(html.indexOf('<main>'), html.indexOf('</main>') + 7);
  const chrome = {
    runtime: { sendMessage: async () => ({}) },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]])),
        set: async (obj) => Object.assign(store, obj),
      },
    },
  };
  await loadModule('options/keys.ts', { document: doc, chrome }).create(page);
  return page;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the options page', () => {
  it('a stored key is acknowledged but never put back on screen', async () => {
    const page = await open({ apiKey: 'sk-ant-SECRET-wxyz' });
    assert.deepStrictEqual(page.querySelector('#key-anthropic').value, '');
    assert.deepStrictEqual(
      page.querySelector('#key-anthropic-status').textContent,
      'Saved · ends in wxyz',
    );
    assert.deepStrictEqual(page.querySelector('#key-openai-status').textContent, 'Not set');
  });

  it('Save writes the trimmed key to its own slot and empties the field', async () => {
    const store = {};
    const page = await open(store);
    page.querySelector('#key-openai').value = '  gsk-abcd  ';
    click(page.querySelector('#key-openai-save'));
    await tick();
    assert.deepStrictEqual(store, { openaiApiKey: 'gsk-abcd' });
    assert.deepStrictEqual(page.querySelector('#key-openai').value, '');
  });

  it('Remove clears the slot', async () => {
    const store = { apiKey: 'sk-ant-x' };
    const page = await open(store);
    click(page.querySelector('#key-anthropic-remove'));
    await tick();
    assert.deepStrictEqual(store.apiKey, '');
    assert.deepStrictEqual(page.querySelector('#key-anthropic-status').textContent, 'Not set');
  });
});
