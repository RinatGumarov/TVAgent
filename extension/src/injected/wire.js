/**
 * TVAgent — the page bridge's wire format and its authentication.
 *
 * driver.js runs in the page's own JavaScript world and bridge.js in the
 * extension's isolated one. Neither can import from the other, but they have to
 * agree on the protocol exactly, so this file is the single definition of it
 * and each world is given a copy.
 *
 * A copy, and not one file named twice in the manifest: Chrome injects a script
 * file into a document once, and the first content_scripts entry to list it
 * takes it — along with the world that entry asked for. Listing this file under
 * both entries is how it ended up in the MAIN world only, leaving bridge.js to
 * throw on `wire.id()` with nothing in the manifest looking wrong. So the MAIN
 * world reads src/injected/wire.js, this is what the isolated world reads, and
 * tools/sync-worlds.sh copies this over that. Edit this one; the manifest test
 * fails if the two ever differ.
 *
 * The channel itself is `window.postMessage`, which every script on the page
 * can read and write. Origin and source checks say the message came from this
 * page; they say nothing about *which* script on it. So the two ends establish
 * a shared secret once and stamp every message with an HMAC derived from it:
 *
 *   - a page script cannot invoke a driver method (no valid request stamp), and
 *   - a page script cannot answer one either (the response stamp is over the
 *     request id with a key it does not have), which is what would otherwise
 *     let it race the driver and poison a tool result.
 *
 * A request's stamp covers what it asks for, not just its id — see body() for
 * why signing the id alone authenticated nothing: a stamp lifted off any
 * request the page had watched go by could be pasted onto a request that said
 * something else. Events are bound the same way. The driver also answers a
 * given id once, so a whole request cannot be captured and played back.
 *
 * A response is still bound by its id alone, and that is enough: the id is an
 * unguessable value the content script has just minted, and it leaves `pending`
 * the moment the first valid answer arrives. There is no second answer to give
 * and no id to guess, so there is nothing a captured response stamp is good
 * for — and keeping driver results off the JSON path leaves them free to be
 * whatever structured clone accepts.
 *
 * The secret is exchanged in the clear exactly once, at document_start. That is
 * safe against page-authored scripts — content scripts run before the parser
 * has produced a single <script> element, so nothing of TradingView's is
 * listening yet — and it is the one assumption this design rests on. The
 * exchange is not retried on a timer, because a retry is a nonce broadcast into
 * a page whose own scripts are running by then; a driver that loads late
 * announces itself instead, and the content script asks again on that cue.
 * Another extension injecting at document_start could still claim the handshake
 * ahead of us — it would take the secret and the panel would come up saying the
 * driver never answered. There is no way to exclude that from inside a page.
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
     * What a stamp covers, besides the id: the message's whole meaning.
     *
     * Signing the id alone was not enough. Every message on this channel is
     * readable by every script on the page, so a stamp seen once could be
     * lifted onto a message that said something else entirely — the id matched,
     * the stamp verified, and `probe` became `set_pine_code` with the caller's
     * own Pine. The verb and its arguments are signed with the id now, so a
     * captured stamp is good for the one message it was made for.
     *
     * JSON, and not the object: both ends must agree on the exact bytes, and
     * everything that travels here is plain JSON already — tool parameters come
     * from the model as JSON, and probe reports are flat data.
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
