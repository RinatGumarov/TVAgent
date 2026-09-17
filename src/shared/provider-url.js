/**
 * TVAgent — the provider URL policy shared by the settings screen and the
 * worker. Hosted providers must use HTTPS; plain HTTP is accepted only for a
 * process on this machine.
 */

function parse(value) {
  const raw = String(value || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new Error('Enter a valid URL, such as http://localhost:11434/v1.', { cause: err });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The provider URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials in the provider URL; use the API key field.');
  }
  if (url.search || url.hash) {
    throw new Error('The provider URL cannot contain a query string or fragment.');
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !loopback) {
    throw new Error(
      'Hosted providers must use HTTPS; HTTP is allowed only for localhost or 127.0.0.1.',
    );
  }

  const path = url.pathname.replace(/\/+$/, '');
  const baseUrl = `${url.origin}${path === '/' ? '' : path}`;
  const permission = `${url.protocol}//${url.hostname}/*`;
  return { baseUrl, permission, loopback };
}

export { parse };
