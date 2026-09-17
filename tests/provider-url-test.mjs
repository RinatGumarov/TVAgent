/** The provider URL policy shared by the panel and the worker. */
import { check, section, report } from './helpers/check.mjs';
import { loadShared } from './helpers/load.mjs';

const { TVAgentProviderURL: providerURL } = loadShared('shared/provider-url.js');

section('normalizing provider URLs');

{
  const local = providerURL.parse('  http://localhost:11434/v1/  ');
  check('localhost HTTP is allowed and normalized', local.baseUrl, 'http://localhost:11434/v1');
  check('localhost requests only its host permission', local.permission, 'http://localhost/*');
}

{
  const loopback = providerURL.parse('http://127.0.0.1:1234/v1');
  check('IPv4 loopback HTTP is allowed', loopback.baseUrl, 'http://127.0.0.1:1234/v1');
  check('the permission does not widen to every HTTP host', loopback.permission, 'http://127.0.0.1/*');
}

{
  const hosted = providerURL.parse('https://api.groq.com/openai/v1/');
  check('a hosted HTTPS endpoint is allowed and normalized', hosted.baseUrl, 'https://api.groq.com/openai/v1');
  check('the grant is scoped to that one host', hosted.permission, 'https://api.groq.com/*');
}

section('rejecting unsafe or ambiguous URLs');

const rejected = (value) => {
  try {
    providerURL.parse(value);
    return null;
  } catch (err) {
    return err.message;
  }
};

check('remote plaintext HTTP is refused', /HTTPS|localhost|127\.0\.0\.1/.test(rejected('http://api.example.com/v1') || ''), true);
check('credentials embedded in a URL are refused', /credentials/i.test(rejected('https://key:secret@api.example.com/v1') || ''), true);
check('query parameters are refused', /query|fragment/i.test(rejected('https://api.example.com/v1?key=secret') || ''), true);
check('non-HTTP protocols are refused', /HTTP/i.test(rejected('file:///tmp/model') || ''), true);
check('an invalid URL is refused in the user’s terms', /valid URL/i.test(rejected('not a url') || ''), true);

report();
