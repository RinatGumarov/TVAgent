/**
 * TVAgent — the page bridge's wire format and its authentication.
 *
 * driver.js (page world) and bridge.js (isolated world) each load a copy of
 * this file: Chrome hands a script file to the first content_scripts entry
 * that lists it, so one file cannot serve two worlds. Edit src/shared and run
 * tools/sync-worlds.sh; manifest-test.mjs fails if the copies differ.
 *
 * window.postMessage is readable and writable by every script on the page, so
 * the two ends agree a secret once at document_start, before any page script
 * runs, and stamp every message with an HMAC over its id, role and body. A
 * page script can neither invoke a driver method nor answer one in the
 * driver's place, and the driver answers each request id once.
 */
(() => {
  'use strict';

  const SUBTLE = globalThis.crypto && globalThis.crypto.subtle;

  globalThis.TVAgentWire = {
    /** Content script → driver, expecting a RES. */
    REQ: 'tva-req',
    /** Driver → content script, answering one REQ. */
    RES: 'tva-res',
    /** Driver → content script, unsolicited. */
    EVT: 'tva-evt',
    /** The one exchange that hands the two ends their shared secret. */
    HELLO: 'tva-hello',

    /**
     * Unguessable, because a page script that could guess a request id could
     * answer a request it never saw.
     */
    id() {
      if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
      const bytes = new Uint8Array(18);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    },

    /** The shared secret, as an HMAC key both ends can sign with. */
    async key(secret) {
      return SUBTLE.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
    },

    /**
     * What a stamp covers besides the id: the verb and its payload, as JSON,
     * so a stamp lifted off one request cannot be pasted onto another.
     */
    body(verb, payload) {
      return JSON.stringify([verb, payload === undefined ? null : payload]);
    },

    /**
     * The stamp on one message. `role` separates a request from its response,
     * so seeing the request's stamp never tells anyone the response's.
     */
    async stamp(key, id, role, body = '') {
      const mac = await SUBTLE.sign('HMAC', key, new TextEncoder().encode(`${role}:${id}:${body}`));
      return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
})();
