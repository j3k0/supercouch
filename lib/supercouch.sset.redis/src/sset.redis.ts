import { SSetDB, SSetOp, SSetRangeQuery, SSetRangeResponse } from "supercouch.sset";
import * as redis from "redis";

/** Convenience method to create a redis client and wait for connection */
export async function prepareRedisClient(url: string): Promise<redis.RedisClientType> {
  const client: redis.RedisClientType = redis.createClient({ url });
  await client.connect();
  return client;
}

/** A SuperCouch Sorted Database implemented with Redis */
export class SSetRedis implements SSetDB {

  /** Our link with redis */
  private redisClient: redis.RedisClientType;

  constructor(redisClient: redis.RedisClientType) {
    this.redisClient = redisClient;
  }

  /** Format the Redis keys */
  static key(db: string, key: string[]): string {
    return 'SSET:' + db + '/' + key.map(encodeURIComponent).join(':');
  }

  /** @inheritdoc */
  process<T>(ops: SSetOp<T>[]): Promise<any> {
    for (let op of ops) {
      if (!op.id || !op.id.length || !op.keep)
        throw new Error('Invalid $SSET operation for ' + JSON.stringify(op));
    }
    const multi = this.redisClient.multi();
    for (let op of ops) {
      const key = SSetRedis.key(op.db, op.id);
      const score = op.score;
      const value = JSON.stringify(op.value);
      multi.zAdd(key, { score, value }, { 'GT': true });
      switch (op.keep) {
        case "ALL_VALUES":
          break;
        case "LAST_VALUE":
          multi.zRemRangeByRank(key, 0, -2);
          break;
        default:
          // In case the user gives a wrong value for keep
          throw new Error('Unsupported value for $SSET "keep" field: ' + op.keep);
      }
    }
    return multi.exec();
  }

  private async rangeBy<T>(by: 'SCORE' | 'INDEX', db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
    const key = SSetRedis.key(db, id);
    const isReversed = (query.order === 'desc' && by === 'SCORE');
    const [min, max] = isReversed ? [query.max, query.min] : [query.min, query.max];
    const options: any = {};
    if (by === 'SCORE') {
      options.BY = by;
    }
    if (typeof query.offset == 'number' || typeof query.count === 'number') {
      options.LIMIT = {
        count: query.count ?? 9999999999,
        offset: query.offset ?? 0,
      }
    }
    if (isReversed) {
      options.REV = true;
    }
    const [values, total] = await Promise.all([
      this.redisClient.zRange(key, min, max, options),
      query.includeTotal
        ? (this.redisClient.zCount(key, query.min, query.max))
        : new Promise<number>(resolve => resolve(-1)),
    ]);
    return {
      paging: {
        count: options.LIMIT?.count ?? -1,
        offset: options.LIMIT.offset ?? 0,
        total: typeof total === 'number' ? total : -1,
      },
      rows: values.map(v => JSON.parse(v) as T)
    }
  }

  /** @inheritdoc */
  rangeByScore<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
    return this.rangeBy('SCORE', db, id, query);
  }

  /** @inheritdoc */
  rangeByIndex<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
    return this.rangeBy('INDEX', db, id, query);
  }
}
