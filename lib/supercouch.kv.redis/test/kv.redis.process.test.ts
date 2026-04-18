import { describe, it, beforeEach } from 'mocha';
import * as td from 'testdouble';
import * as assert from 'assert';
import { RedisClientType } from 'redis';
import { KVRedis } from '../src/kv.redis';

type MultiStub = {
  calls: { key: string; value: string; opts?: any }[];
  set: (key: string, value: string, opts?: any) => MultiStub;
  exec: () => Promise<any[]>;
};

function buildMulti(): MultiStub {
  // A chainable recording stub: each .set() call appends to `calls` and
  // returns the same object, mimicking redis multi()'s fluent API.
  const calls: { key: string; value: string; opts?: any }[] = [];
  const multi: any = {
    calls,
    set(key: string, value: string, opts?: any) { calls.push({ key, value, opts }); return multi; },
    exec: td.function() as any,
  };
  td.when(multi.exec()).thenResolve([]);
  return multi;
}

describe('KVRedis.process — happy path', () => {
  let redisClient: RedisClientType;

  beforeEach(() => {
    redisClient = td.object<RedisClientType>() as RedisClientType;
  });

  it('writes a persistent key (no expiresAt) via SET without EX', async () => {
    const multi = buildMulti();
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    await kv.process([{ db: 'mydb', id: ['abc'], value: { hello: 'world' } }]);

    assert.strictEqual((multi as any).calls.length, 1);
    assert.strictEqual((multi as any).calls[0].key, '{KV:mydb}/abc');
    assert.strictEqual((multi as any).calls[0].value, '{"hello":"world"}');
    assert.strictEqual((multi as any).calls[0].opts, undefined);
  });

  it('writes a TTL key (future expiresAt) via SET with EX', async () => {
    const multi = buildMulti();
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + 3600; // 1h from now
    await kv.process([{ db: 'mydb', id: ['abc'], value: 42, expiresAt }]);

    assert.strictEqual((multi as any).calls.length, 1);
    assert.strictEqual((multi as any).calls[0].key, '{KV:mydb}/abc');
    assert.strictEqual((multi as any).calls[0].value, '42');
    // EX is computed as expiresAt - nowSec; allow ±1s for test-clock drift.
    const ex = (multi as any).calls[0].opts?.EX;
    assert.ok(typeof ex === 'number', 'EX should be set');
    assert.ok(ex >= 3599 && ex <= 3601, `EX should be ~3600, got ${ex}`);
  });

  it('groups ops by db into separate MULTIs (one per db)', async () => {
    // For cluster compatibility, each {KV:<db>} hash tag must stay on its own
    // MULTI so all keys in one transaction map to a single slot.
    const multiA = buildMulti();
    const multiB = buildMulti();
    // We can't easily stub two different returns with testdouble; fake manually.
    let callCount = 0;
    (redisClient as any).multi = () => (callCount++ === 0 ? multiA : multiB);

    const kv = new KVRedis(redisClient);
    await kv.process([
      { db: 'dbA', id: ['x'], value: 1 },
      { db: 'dbB', id: ['y'], value: 2 },
      { db: 'dbA', id: ['z'], value: 3 },
    ]);

    // Two MULTIs created.
    assert.strictEqual(callCount, 2);
    // First multi (dbA) got two sets.
    assert.strictEqual(multiA.calls.length, 2);
    // Second multi (dbB) got one set.
    assert.strictEqual(multiB.calls.length, 1);
  });

  it('resolves with no error for empty ops array', async () => {
    const kv = new KVRedis(redisClient);
    await kv.process([]); // must not throw, must not call multi()
    td.verify((redisClient as any).multi(), { times: 0 });
  });
});
