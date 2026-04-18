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

  // @ts-ignore - intentional skeleton, implementation in subsequent tasks
  private _redisClient: redis.RedisClientType | redis.RedisClusterType;

  constructor(redisClient: redis.RedisClientType | redis.RedisClusterType) {
    this._redisClient = redisClient;
  }

  /** Build the Redis key for a given (db, id). */
  static key(db: string, id: string[]): string {
    return '{KV:' + db + '}/' + id.map(encodeURIComponent).join(':');
  }

  /** @inheritdoc */
  process<T>(_ops: KVOp<T>[]): Promise<void> {
    throw new Error('KVRedis.process not yet implemented');
  }

  /** @inheritdoc */
  get<T>(_db: string, _id: string[], _options?: KVGetOptions): Promise<KVEntry<T> | undefined> {
    throw new Error('KVRedis.get not yet implemented');
  }

  /** @inheritdoc */
  mget<T>(_db: string, _ids: string[][], _options?: KVGetOptions): Promise<(KVEntry<T> | undefined)[]> {
    throw new Error('KVRedis.mget not yet implemented');
  }
}
