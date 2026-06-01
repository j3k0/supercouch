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

describe('KVRedis.process — silent skip when expiresAt in the past', () => {
  let redisClient: RedisClientType;
  beforeEach(() => { redisClient = td.object<RedisClientType>() as RedisClientType; });

  it('silently skips an op with expiresAt in the past — no MULTI created', async () => {
    // When every op is expired, process() should NOT start a MULTI.
    // This matters operationally: re-indexes replay millions of past ops.
    const pastMulti = buildMulti();
    td.when((redisClient as any).multi()).thenReturn(pastMulti);

    const kv = new KVRedis(redisClient);
    const pastSec = Math.floor(Date.now() / 1000) - 10;
    await kv.process([{ db: 'mydb', id: ['x'], value: 1, expiresAt: pastSec }]);

    // No SET was queued.
    assert.strictEqual((pastMulti as any).calls.length, 0);
  });

  it('mixes live and expired ops in the same batch — only live ones written', async () => {
    const multi = buildMulti();
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const nowSec = Math.floor(Date.now() / 1000);
    await kv.process([
      { db: 'mydb', id: ['expired'], value: 'skip', expiresAt: nowSec - 1 },
      { db: 'mydb', id: ['live'], value: 'keep', expiresAt: nowSec + 3600 },
      { db: 'mydb', id: ['exact-now'], value: 'skip', expiresAt: nowSec },
    ]);

    // Only the "live" op made it into MULTI.
    assert.strictEqual((multi as any).calls.length, 1);
    assert.strictEqual((multi as any).calls[0].key, '{KV:mydb}/live');
  });
});

describe('KVRedis.process — validation errors', () => {
  let redisClient: RedisClientType;
  beforeEach(() => { redisClient = td.object<RedisClientType>() as RedisClientType; });

  it('throws when id is missing', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: undefined as any, value: 1 }]),
      /missing id/,
    );
  });

  it('throws when id is an empty array', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: [], value: 1 }]),
      /missing id/,
    );
  });

  it('throws when expiresAt is NaN', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: ['x'], value: 1, expiresAt: NaN }]),
      /invalid expiresAt/,
    );
  });

  it('throws when expiresAt is negative', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: ['x'], value: 1, expiresAt: -100 }]),
      /invalid expiresAt/,
    );
  });

  it('throws when expiresAt is Infinity', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: ['x'], value: 1, expiresAt: Infinity }]),
      /invalid expiresAt/,
    );
  });

  it('validation runs before MULTI — no partial application', async () => {
    // A valid op followed by an invalid one should throw WITHOUT ever
    // starting a MULTI transaction.
    const multi = buildMulti();
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([
        { db: 'mydb', id: ['valid'], value: 1 },
        { db: 'mydb', id: ['invalid'], value: 2, expiresAt: NaN },
      ]),
      /invalid expiresAt/,
    );
    // MULTI was never started; even the "valid" op didn't reach Redis.
    assert.strictEqual((multi as any).calls.length, 0);
  });

  it('throws when value is undefined', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: ['x'], value: undefined as any }]),
      /value is undefined/,
    );
  });

  it('throws when expiresAt is non-integer', async () => {
    const kv = new KVRedis(redisClient);
    await assert.rejects(
      () => kv.process([{ db: 'mydb', id: ['x'], value: 1, expiresAt: 1_700_000_000.5 }]),
      /invalid expiresAt/,
    );
  });
});
