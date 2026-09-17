/** The provider URL policy shared by the panel and the worker. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/load.mjs';

const providerURL = loadModule('shared/provider-url.js');

describe('normalizing provider URLs', () => {
  const local = providerURL.parse('  http://localhost:11434/v1/  ');
  const loopback = providerURL.parse('http://127.0.0.1:1234/v1');
  const hosted = providerURL.parse('https://api.groq.com/openai/v1/');

  it('localhost HTTP is allowed and normalized', () => {
    assert.deepStrictEqual(local.baseUrl, 'http://localhost:11434/v1');
  });

  it('localhost requests only its host permission', () => {
    assert.deepStrictEqual(local.permission, 'http://localhost/*');
  });

  it('IPv4 loopback HTTP is allowed', () => {
    assert.deepStrictEqual(loopback.baseUrl, 'http://127.0.0.1:1234/v1');
  });

  it('the permission does not widen to every HTTP host', () => {
    assert.deepStrictEqual(loopback.permission, 'http://127.0.0.1/*');
  });

  it('a hosted HTTPS endpoint is allowed and normalized', () => {
    assert.deepStrictEqual(hosted.baseUrl, 'https://api.groq.com/openai/v1');
  });

  it('the grant is scoped to that one host', () => {
    assert.deepStrictEqual(hosted.permission, 'https://api.groq.com/*');
  });
});

describe('rejecting unsafe or ambiguous URLs', () => {
  const rejected = (value) => {
    try {
      providerURL.parse(value);
      return null;
    } catch (err) {
      return err.message;
    }
  };

  it('remote plaintext HTTP is refused', () => {
    assert.match(rejected('http://api.example.com/v1') || '', /HTTPS|localhost|127\.0\.0\.1/);
  });

  it('credentials embedded in a URL are refused', () => {
    assert.match(rejected('https://key:secret@api.example.com/v1') || '', /credentials/i);
  });

  it('query parameters are refused', () => {
    assert.match(rejected('https://api.example.com/v1?key=secret') || '', /query|fragment/i);
  });

  it('non-HTTP protocols are refused', () => {
    assert.match(rejected('file:///tmp/model') || '', /HTTP/i);
  });

  it('an invalid URL is refused in the user’s terms', () => {
    assert.match(rejected('not a url') || '', /valid URL/i);
  });
});
