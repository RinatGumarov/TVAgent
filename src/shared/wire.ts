/**
 * TVAgent — the page bridge's wire format and its authentication.
 *
 * The page driver and the content-script bridge both import this module, and
 * the bundler gives each world its own copy; the two cannot drift.
 *
 * window.postMessage is readable and writable by every script on the page, so
 * the two ends agree a secret once at document_start, before any page script
 * runs, and stamp every message with an HMAC over its id, role and body. A
 * page script can neither invoke a driver method nor answer one in the
 * driver's place, and the driver answers each request id once.
 */

/** Which end a message came from; a request's stamp is not its answer's. */
export type WireRole = 'req' | 'res' | 'evt';

const SUBTLE = globalThis.crypto && globalThis.crypto.subtle;

/** Content script → driver, expecting a RES. */
export const REQ = 'tva-req';
/** Driver → content script, answering one REQ. */
export const RES = 'tva-res';
/** Driver → content script, unsolicited. */
export const EVT = 'tva-evt';
/** The one exchange that hands the two ends their shared secret. */
export const HELLO = 'tva-hello';

/**
 * Unguessable, because a page script that could guess a request id could
 * answer a request it never saw.
 */
export function id(): string {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The shared secret, as an HMAC key both ends can sign with. */
export async function key(secret: string): Promise<CryptoKey> {
  return SUBTLE.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * What a stamp covers besides the id: the verb and its payload, as JSON, so a
 * stamp lifted off one request cannot be pasted onto another.
 */
export function body(verb: string, payload?: unknown): string {
  return JSON.stringify([verb, payload === undefined ? null : payload]);
}

/**
 * The stamp on one message. `role` separates a request from its response, so
 * seeing the request's stamp never tells anyone the response's.
 */
export async function stamp(
  hmacKey: CryptoKey,
  messageId: string,
  role: WireRole,
  signedBody = '',
): Promise<string> {
  const mac = await SUBTLE.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(`${role}:${messageId}:${signedBody}`),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}
