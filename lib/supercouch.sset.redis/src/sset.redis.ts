import { SSetDB, SSetOp, SSetOpType, SSetRangeQuery, SSetRangeResponse } from "supercouch.sset";
import * as redis from "redis";

export async function prepareRedisClient(url: string): Promise<redis.RedisClientType> {
  const client: redis.RedisClientType = redis.createClient({ url });
  await client.connect();
  return client;
}

export class SSetRedis implements SSetDB {

  private redisClient: redis.RedisClientType;

  constructor(redisClient: redis.RedisClientType) {
    this.redisClient = redisClient;
  }

  static key(db: string, key: string[]): string {
    return 'SSet:' + db + '/' + key.map(encodeURIComponent).join(':');
  }

  process<T>(op: SSetOp<T>): Promise<any> {
    if (!op.id || !op.id.length || !op.type)
      throw new Error('Invalid $SSET operation: ' + op.type);
    const key = SSetRedis.key(op.db, op.id);
    const score = op.score;
    const value = JSON.stringify(op.value);
    switch (op.type) {
      case SSetOpType.ADD:
        return this.redisClient.zAdd(key, { score, value }, { 'GT': true });
      case SSetOpType.KEEP_LAST:
        return Promise.all([
          this.redisClient.zAdd(key, { score, value }, { 'GT': true }), // only update if order is greater that existing
          this.redisClient.zRemRangeByRank(key, 0, -2),
        ]);
      case SSetOpType.INSERT:
        return this.redisClient.zAdd(key, { score, value }, { 'LT': true });
      case SSetOpType.KEEP_FIRST:
        return Promise.all([
          this.redisClient.zAdd(key, { score, value }, { 'LT': true }), // only update if order is lower that existing
          this.redisClient.zRemRangeByRank(key, 1, -1),
        ]);
    }
    // In case the user gives a wrong type
    throw new Error('Unsupported $SSET operation: ' + op.type);
  }

  first<T>(db: string, id: string[]) {
    return this.at<T>(db, id, 0);
  }

  last<T>(db: string, id: string[]) {
    return this.at<T>(db, id, -1);
  }

  private async at<T>(db: string, id: string[], index: number): Promise<T | null> {
    const values = await this.rangeByIndex<T>(db, id, { min: index, max: index, count: 1 });
    if (values.rows.length) return values.rows[0];
    return null;
  }

  async rangeBy<T>(by: 'SCORE' | 'INDEX', db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
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

  rangeByScore<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
    return this.rangeBy('SCORE', db, id, query);
  }

  rangeByIndex<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
    return this.rangeBy('INDEX', db, id, query);
  }
  /*
  async rangeByDate<T>(key: string[], query: IndexByDateQuery): Promise<Paginated<T>> {
    const strKey = EntitiesDB.redisKey(key);
    const min = +new Date(query.startdate || 0);
    const max = +new Date(query.enddate || '9999-12-31T00:00:00.000Z');
    const skip = query.skip || 0;
    const limit = query.limit || 9999999999;

    const [rows, total] = await Promise.all([
      this.redisClient.zRange(strKey,
        query.order === 'asc' ? min : max,
        query.order === 'asc' ? max : min, {
        REV: query.order === 'desc' ? true : undefined,
        BY: 'SCORE',
        LIMIT: {
          offset: skip,
          count: limit,
        }
      }),
      query.includeTotal
        ? (this.redisClient.zCount(strKey, min, max))
        : new Promise<number>(resolve => resolve(-1)),
    ]);
    return {
      paging: { skip, limit, total },
      rows: rows.map(function (str: string): T { return JSON.parse(str) as T })
    };
  }
  */
}
