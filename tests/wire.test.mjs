/** The shared primitives the bridge rests on: ids, stamps and poll. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './helpers/load.mjs';

const { TVAgentWire: wire, TVAgentWait: wait } = loadShared('shared/wire.js', 'shared/wait.js');

describe('ids', () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(wire.id());

  it('two thousand ids, none repeated', () => {
    assert.deepStrictEqual(ids.size, 2000);
  });

  it('and none of them are a counter', () => {
    assert.doesNotMatch([...ids][0], /^\d+$/);
  });

  it('long enough not to be searched through', () => {
    assert.ok([...ids].every((id) => id.length >= 32));
  });
});

describe('stamps', async () => {
  const key = await wire.key('a-secret');
  const other = await wire.key('a-different-secret');
  const req = await wire.stamp(key, 'id-1', 'req');

  it('a stamp is deterministic for one key, id and role', async () => {
    assert.deepStrictEqual(await wire.stamp(key, 'id-1', 'req'), req);
  });

  // A page script can read the request off the shared channel, so its stamp
  // must not be the answer's.
  it('the response stamp differs from the request stamp', async () => {
    assert.notDeepStrictEqual(await wire.stamp(key, 'id-1', 'res'), req);
  });

  it('another id gives another stamp', async () => {
    assert.notDeepStrictEqual(await wire.stamp(key, 'id-2', 'req'), req);
  });

  it('and another key gives another stamp', async () => {
    assert.notDeepStrictEqual(await wire.stamp(other, 'id-1', 'req'), req);
  });

  it('it is a full SHA-256 in hex', () => {
    assert.match(req, /^[0-9a-f]{64}$/);
  });
});

describe('poll', () => {
  it('it returns the first truthy value, and stops asking once it has one', async () => {
    let calls = 0;
    const value = await wait.poll(
      () => {
        calls++;
        return calls >= 3 ? 'ready' : null;
      },
      { attempts: 10, intervalMs: 1 },
    );
    assert.deepStrictEqual(value, 'ready');
    assert.deepStrictEqual(calls, 3);
  });

  it('a wait that never comes returns null, after exactly the attempts it was given', async () => {
    let calls = 0;
    const value = await wait.poll(
      () => {
        calls++;
        return null;
      },
      { attempts: 4, intervalMs: 1 },
    );
    assert.deepStrictEqual(value, null);
    assert.deepStrictEqual(calls, 4);
  });

  it('the first check happens before any sleep, so a ready condition costs no waiting', async () => {
    let calls = 0;
    const value = await wait.poll(
      () => {
        calls++;
        return 'at once';
      },
      { attempts: 5, intervalMs: 10000 },
    );
    assert.deepStrictEqual(value, 'at once');
    assert.deepStrictEqual(calls, 1);
  });

  it('an async check is awaited', async () => {
    const value = await wait.poll(async () => 'from a promise', { attempts: 2, intervalMs: 1 });
    assert.deepStrictEqual(value, 'from a promise');
  });
});
