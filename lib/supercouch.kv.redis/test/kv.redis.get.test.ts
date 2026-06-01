import { describe, it, beforeEach } from 'mocha';
import * as td from 'testdouble';
import * as assert from 'assert';
import { RedisClientType } from 'redis';
import { KVRedis } from '../src/kv.redis';

// Build a chainable multi() stub that records its queued commands and returns
// pre-programmed exec() results.
function buildMulti(execResult: any[]): any {
  const calls: { method: string; args: any[] }[] = [];
  const multi: any = {
    calls,
    get(key: string) { calls.push({ method: 'get', args: [key] }); return multi; },
    pTTL(key: string) { calls.push({ method: 'pTTL', args: [key] }); return multi; },
    exec: () => Promise.resolve(execResult),
  };
  return multi;
}

describe('KVRedis.get', () => {
  let redisClient: RedisClientType;

  beforeEach(() => {
    redisClient = td.object<RedisClientType>() as RedisClientType;
  });

  it('returns {value, expiresAt} for a TTL hit (default includeExpiresAt)', async () => {
    // Redis returns raw JSON value + pTTL in millis.
    const multi = buildMulti(['{"hello":"world"}', 60_000]); // 60s remaining
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await kv.get<{hello: string}>('mydb', ['abc']);

    assert.deepStrictEqual(result?.value, { hello: 'world' });
    assert.ok(result?.expiresAt !== undefined);
    // 60s from now, ±1s tolerance.
    assert.ok(result!.expiresAt! >= nowSec + 59 && result!.expiresAt! <= nowSec + 61,
      `expiresAt should be ~now+60, got ${result!.expiresAt! - nowSec}`);
    assert.deepStrictEqual(multi.calls, [
      { method: 'get',  args: ['{KV:mydb}/abc'] },
      { method: 'pTTL', args: ['{KV:mydb}/abc'] },
    ]);
  });

  it('returns {value} only (no expiresAt) for a persistent-key hit (pTTL = -1)', async () => {
    const multi = buildMulti(['42', -1]); // persistent key
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const result = await kv.get<number>('mydb', ['abc']);

    assert.strictEqual(result?.value, 42);
    assert.strictEqual(result?.expiresAt, undefined);
  });

  it('returns undefined when the key is absent (GET = null, pTTL = -2)', async () => {
    const multi = buildMulti([null, -2]);
    td.when((redisClient as any).multi()).thenReturn(multi);

    const kv = new KVRedis(redisClient);
    const result = await kv.get('mydb', ['missing']);

    assert.strictEqual(result, undefined);
  });

  it('skips PTTL round-trip when includeExpiresAt: false — uses plain GET', async () => {
    // No multi() call; direct get().
    td.when((redisClient as any).get('{KV:mydb}/abc')).thenResolve('"persisted"');

    const kv = new KVRedis(redisClient);
    const result = await kv.get<string>('mydb', ['abc'], { includeExpiresAt: false });

    assert.strictEqual(result?.value, 'persisted');
    assert.strictEqual(result?.expiresAt, undefined);
    // Verify multi() was NOT called.
    td.verify((redisClient as any).multi(), { times: 0 });
  });

  it('returns undefined from plain GET when includeExpiresAt: false and key missing', async () => {
    td.when((redisClient as any).get('{KV:mydb}/missing')).thenResolve(null);

    const kv = new KVRedis(redisClient);
    const result = await kv.get('mydb', ['missing'], { includeExpiresAt: false });

    assert.strictEqual(result, undefined);
  });
});
