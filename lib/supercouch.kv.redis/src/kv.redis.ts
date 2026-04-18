import { KVDB, KVEntry, KVGetOptions, KVOp } from "supercouch.kv";
import * as redis from "redis";

/** SuperCouch Key-Value database backed by Redis.
 *
 * All implementation lives in this class. The instance takes a pre-connected
 * Redis client (single-node or cluster) and routes reads/writes to it.
 *
 * Key layout: `{KV:<db>}/<encodeURIComponent(id[0])>:<encodeURIComponent(id[1])>:...`
 * The `{KV:<db>}` prefix is a Redis cluster hash tag, pinning all keys for one
 * logical db to a single slot (so MULTI stays on one node).
 */
export class KVRedis implements KVDB {

  private redisClient: redis.RedisClientType | redis.RedisClusterType;

  constructor(redisClient: redis.RedisClientType | redis.RedisClusterType) {
    this.redisClient = redisClient;
  }

  /** Build the Redis key for a given (db, id). */
  static key(db: string, id: string[]): string {
    return '{KV:' + db + '}/' + id.map(encodeURIComponent).join(':');
  }

  /** @inheritdoc */
  async process<T>(ops: KVOp<T>[]): Promise<void> {
    const groups: { [db: string]: KVOp<T>[] } = {};
    for (const op of ops) {
      if (!op.id || !op.id.length) {
        throw new Error('Invalid $KV operation: missing id — ' + JSON.stringify(op));
      }
      if (op.expiresAt !== undefined &&
          (typeof op.expiresAt !== 'number' ||
           !isFinite(op.expiresAt) ||
           op.expiresAt < 0)) {
        throw new Error('Invalid $KV operation: invalid expiresAt — ' + JSON.stringify(op));
      }
      if (!groups[op.db]) groups[op.db] = [];
      groups[op.db].push(op);
    }

    const nowSec = Math.floor(Date.now() / 1000);

    const promises: Promise<any>[] = Object.keys(groups).map(db => {
      const dbOps = groups[db];
      let multi = this.redisClient.multi();
      let wrote = false;
      for (const op of dbOps) {
        if (op.expiresAt !== undefined && op.expiresAt <= nowSec) {
          continue; // silent skip per contract
        }
        const key = KVRedis.key(op.db, op.id);
        const value = JSON.stringify(op.value);
        if (op.expiresAt === undefined) {
          multi = multi.set(key, value);
        } else {
          multi = multi.set(key, value, { EX: op.expiresAt - nowSec });
        }
        wrote = true;
      }
      return wrote ? multi.exec() : Promise.resolve([]);
    });

    await Promise.all(promises);
  }

  /** @inheritdoc */
  async get<T>(db: string, id: string[], options?: KVGetOptions): Promise<KVEntry<T> | undefined> {
    const key = KVRedis.key(db, id);
    if (options?.includeExpiresAt === false) {
      const raw = await this.redisClient.get(key);
      return raw == null ? undefined : { value: JSON.parse(raw) as T };
    }
    // Pipeline GET + PTTL in one round-trip to avoid a TTL/GET race.
    const results = await this.redisClient.multi().get(key).pTTL(key).exec() as [string | null, number];
    const raw = results[0];
    const pttlMs = results[1];
    if (raw == null) return undefined;            // PTTL returns -2 for absent keys
    const value = JSON.parse(raw) as T;
    if (pttlMs === -1) return { value };          // persistent
    return { value, expiresAt: Math.floor(Date.now() / 1000 + pttlMs / 1000) };
  }

  /** @inheritdoc */
  mget<T>(_db: string, _ids: string[][], _options?: KVGetOptions): Promise<(KVEntry<T> | undefined)[]> {
    throw new Error('KVRedis.mget not yet implemented');
  }
}
