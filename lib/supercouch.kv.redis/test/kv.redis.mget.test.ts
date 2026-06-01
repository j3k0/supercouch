import { describe, it, beforeEach } from 'mocha';
import * as td from 'testdouble';
import * as assert from 'assert';
import { RedisClientType } from 'redis';
import { KVRedis } from '../src/kv.redis';

function buildMultiGetPTTL(execResult: any[]): any {
  // Chainable stub for pipelined GET+PTTL pairs.
  const calls: { method: string; args: any[] }[] = [];
  const multi: any = {
    calls,
    get(key: string) { calls.push({ method: 'get', args: [key] }); return multi; },
    pTTL(key: string) { calls.push({ method: 'pTTL', args: [key] }); return multi; },
    exec: () => Promise.resolve(execResult),
  };
  return multi;
}

describe('KVRedis.mget', () => {
  let redisClient: RedisClientType;

  beforeEach(() => {
    redisClient = td.object<RedisClientType>() as RedisClientType;
  });

  it('returns [] for an empty ids array (no Redis call)', async () => {
    const kv = new KVRedis(redisClient);
    const result = await kv.mget('mydb', []);
    assert.deepStrictEqual(result, []);
    td.verify((redisClient as any).multi(), { times: 0 });
    td.verify((redisClient as any).mGet(td.matchers.anything() as any), { times: 0 });
  });

  it('preserves positional alignment: mixed hit/miss keeps input order', async () => {
    // 3 keys: hit, miss, hit. Exec result interleaves GET/PTTL per key.
    const multi = buildMultiGetPTTL([
      '"value-A"', 30_000,   // ids[0]: hit, 30s TTL
      null, -2,              // ids[1]: miss
      '"value-C"', -1,       // ids[2]: persistent hit
    ]);
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const result = await kv.mget<string>('mydb', [['a'], ['b'], ['c']]);

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0]?.value, 'value-A');
    assert.ok(result[0]?.expiresAt !== undefined);
    assert.strictEqual(result[1], undefined); // miss preserved at index 1
    assert.strictEqual(result[2]?.value, 'value-C');
    assert.strictEqual(result[2]?.expiresAt, undefined); // persistent
  });

  it('all-miss input returns array of undefineds of correct length', async () => {
    const multi = buildMultiGetPTTL([null, -2, null, -2]);
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const result = await kv.mget('mydb', [['x'], ['y']]);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], undefined);
    assert.strictEqual(result[1], undefined);
  });

  it('uses MGET (not MULTI) when includeExpiresAt: false', async () => {
    td.when((redisClient as any).mGet(['{KV:mydb}/a', '{KV:mydb}/b']))
      .thenResolve(['"v1"', null]);

    const kv = new KVRedis(redisClient);
    const result = await kv.mget<string>('mydb', [['a'], ['b']], { includeExpiresAt: false });

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]?.value, 'v1');
    assert.strictEqual(result[0]?.expiresAt, undefined);
    assert.strictEqual(result[1], undefined);
    td.verify((redisClient as any).multi(), { times: 0 });
  });

  it('pipelines GET + PTTL for each key in one exec (default includeExpiresAt)', async () => {
    const multi = buildMultiGetPTTL(['"1"', -1, '"2"', -1]);
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    await kv.mget('mydb', [['a'], ['b']]);

    // Each key issues GET then PTTL, in order.
    assert.deepStrictEqual(multi.calls, [
      { method: 'get',  args: ['{KV:mydb}/a'] },
      { method: 'pTTL', args: ['{KV:mydb}/a'] },
      { method: 'get',  args: ['{KV:mydb}/b'] },
      { method: 'pTTL', args: ['{KV:mydb}/b'] },
    ]);
  });

  it('uses the same expiresAt formula as get() for the same key state', async () => {
    // Both get() and mget() should produce identical expiresAt for identical
    // (now, pttlMs) inputs. Using identical pttl and near-identical Date.now(),
    // the results should be at most 1 off (clock tick between calls) but
    // should NOT differ structurally. We verify by stubbing both and comparing.
    const sharedPttl = 12_345;
    const multiGet: any = {
      get(_k: string) { return multiGet; },
      pTTL(_k: string) { return multiGet; },
      exec: () => Promise.resolve(['"v"', sharedPttl]),
    };
    const multiMget: any = {
      get(_k: string) { return multiMget; },
      pTTL(_k: string) { return multiMget; },
      exec: () => Promise.resolve(['"v"', sharedPttl]),
    };
    let call = 0;
    (redisClient as any).multi = () => call++ === 0 ? multiGet : multiMget;

    const kv = new KVRedis(redisClient);
    const single = await kv.get<string>('mydb', ['a']);
    const batch  = await kv.mget<string>('mydb', [['a']]);

    // Both should have populated expiresAt.
    assert.ok(single?.expiresAt !== undefined);
    assert.ok(batch[0]?.expiresAt !== undefined);
    // They should be within 1 second of each other (accounting for a clock
    // tick between the two Date.now() reads). Pre-fix they could differ by
    // up to 1s independently of the tick; post-fix the only source of drift
    // is the actual elapsed time between the two Date.now() calls.
    const delta = Math.abs(batch[0]!.expiresAt! - single.expiresAt!);
    assert.ok(delta <= 1, `get/mget expiresAt should be within 1s; got delta=${delta}`);
  });
});
