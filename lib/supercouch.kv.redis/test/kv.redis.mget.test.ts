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
});
