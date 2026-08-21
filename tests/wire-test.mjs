/**
 * TVAgent — the two shared primitives the rest of the bridge rests on.
 *
 * shared/wire.js is what separates the extension's traffic from every other
 * script on the page, so its properties are worth stating on their own rather
 * than only through bridge-test.mjs: an id nobody can guess, and a stamp that
 * binds to both the id and the role, made with a key only the two ends hold.
 *
 * shared/wait.js replaced four hand-written poll loops that each had a
 * different idea of when to check and what to return.
 *
 *   node wire-test.mjs
 */
import { check, section, report } from './helpers/check.mjs';
import { loadShared, tick } from './helpers/load.mjs';

const { TVAgentWire: wire, TVAgentWait: wait } = loadShared('shared/wire.js', 'shared/wait.js');

section('ids');

{
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(wire.id());
  check('two thousand ids, none repeated', ids.size, 2000);
  check('and none of them are a counter', /^\d+$/.test([...ids][0]), false);
  check('long enough not to be searched through', [...ids].every((id) => id.length >= 32), true);
}

section('stamps');

{
  const key = await wire.key('a-secret');
  const other = await wire.key('a-different-secret');

  const req = await wire.stamp(key, 'id-1', 'req');
  check('a stamp is deterministic for one key, id and role', await wire.stamp(key, 'id-1', 'req'), req);

  // The role separation is the whole point: a page script can read the request
  // off the shared channel, so its stamp must not be the answer's.
  check('the response stamp differs from the request stamp', await wire.stamp(key, 'id-1', 'res') === req, false);
  check('another id gives another stamp', await wire.stamp(key, 'id-2', 'req') === req, false);
  check('and another key gives another stamp', await wire.stamp(other, 'id-1', 'req') === req, false);

  check('it is a full SHA-256 in hex', /^[0-9a-f]{64}$/.test(req), true);
}

section('poll');

{
  let calls = 0;
  const value = await wait.poll(() => { calls++; return calls >= 3 ? 'ready' : null; }, { attempts: 10, intervalMs: 1 });
  check('it returns the first truthy value', value, 'ready');
  check('and stops asking once it has one', calls, 3);
}

{
  let calls = 0;
  const value = await wait.poll(() => { calls++; return null; }, { attempts: 4, intervalMs: 1 });
  check('a wait that never comes returns null', value, null);
  check('after exactly the attempts it was given', calls, 4);
}

{
  let calls = 0;
  const value = await wait.poll(() => { calls++; return 'at once'; }, { attempts: 5, intervalMs: 10000 });
  check('the first check happens before any sleep', value, 'at once');
  check('so a ready condition costs no waiting', calls, 1);
}

{
  const value = await wait.poll(async () => 'from a promise', { attempts: 2, intervalMs: 1 });
  check('an async check is awaited', value, 'from a promise');
}

await tick();
report();
