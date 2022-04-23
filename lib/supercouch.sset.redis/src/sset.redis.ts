import { SSetDB, SSetOp, SSetRangeQuery, SSetRangeResponse } from "supercouch.sset";
import * as redis from "redis";

/** Convenience method to create a redis client and wait for connection
 *
 * - For single-node configuration, it accepts a "redis://" formatted URL.
 * - For cluster configuration, it accepts an url in the form: "redis-cluster://<rootNodeURL>,<rootNodeURL>,...[+nodeAddressMap]"
 *   where each root node url is a redis url.
 *   It can be followed with a "+" sign and the node address map in this format: "<address>=<host>:<port>,<address>=<host>:,<port>,..."
 *   See https://github.com/redis/node-redis/blob/master/docs/clustering.md for details.
 */
export async function prepareRedisClient(url: string): Promise<redis.RedisClientType | redis.RedisClusterType> {
  let client: redis.RedisClientType | redis.RedisClusterType;
  if (url.slice(0, 16) === 'redis-cluster://') {
    const tokens = url.slice(16).split('+');
    const rootNodes = tokens[0].split(',');
    let nodeAddressMap: { [address: string]: { host: string, port: number } } | undefined = undefined;
    if (tokens.length > 1) {
      nodeAddressMap = {};
      tokens[1].split(',').forEach(kv => {
        const [key, hostPort] = kv.split('=');
        if (key && hostPort) {
          const [host, port] = hostPort.split(':');
          if (host && port) {
            nodeAddressMap![key] = {
              host,
              port: parseInt(port)
            };
          }
        }
      });
    }
    client = redis.createCluster({
      rootNodes: rootNodes.map(rootNodeURL => ({
        url: rootNodeURL
      })),
      nodeAddressMap
    });
  }
  else {
    client = redis.createClient({ url });
  }
  await client.connect();
  return client;
}

/** A SuperCouch Sorted Database implemented with Redis */
export class SSetRedis implements SSetDB {

  /** Our link with redis */
  private redisClient: redis.RedisClientType | redis.RedisClusterType;

  constructor(redisClient: redis.RedisClientType | redis.RedisClusterType) {
    this.redisClient = redisClient;
  }

  /** Format the Redis keys */
  static key(db: string, key: string[]): string {
    return '{SSET:' + db + '}/' + key.map(encodeURIComponent).join(':');
  }

  /** @inheritdoc */
  process<T>(ops: SSetOp<T>[]): Promise<any> {
    const groups: { [db: string]: SSetOp<T>[] } = {};
    for (let op of ops) {
      if (!op.id || !op.id.length || !op.keep)
        throw new Error('Invalid $SSET operation for ' + JSON.stringify(op));
      if (!groups[op.db]) {
        groups[op.db] = [op];
      }
      else {
        groups[op.db].push(op);
      }
    }
    const promises: Promise<any>[] = Object.keys(groups).map(db => {
      let multi = this.redisClient.multi();
      for (let op of ops) {
        const key = SSetRedis.key(op.db, op.id);
        const score = op.score;
        const value = JSON.stringify(op.value);
        multi = multi.zAdd(key, { score, value }, { 'GT': true });
        switch (op.keep) {
          case "ALL_VALUES":
            break;
          case "LAST_VALUE":
            multi = multi.zRemRangeByRank(key, 0, -2);
            break;
          default:
            // In case the user gives a wrong value for keep
            throw new Error('Unsupported value for $SSET "keep" field: ' + op.keep);
        }
      }
      return multi.exec();
    });
    return Promise.all(promises);
  }

  private async rangeBy<T>(by: 'SCORE' | 'INDEX', db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>> {
    const key = SSetRedis.key(db, id);
    const isReversed = (query.order === 'desc' && by === 'SCORE');
    const [min, max] = isReversed ? [query.max, query.min] : [query.min, query.max];
    const options: any = {};
    if (by === 'SCORE') {
      options.BY = by;
    }
    const hasOffsetOrCount = typeof query.offset == 'number' || typeof query.count === 'number';
    if (hasOffsetOrCount) {
      options.LIMIT = {
        count: query.count ?? 9999999999,
        offset: query.offset ?? 0,
      }
    }
    if (isReversed) {
      options.REV = true;
    }
    const needZCount = query.includeTotal && hasOffsetOrCount;
    const [values, total] = await Promise.all([
      zRange(this.redisClient, query.includeScores ?? false, key, min, max, options),
      needZCount
        ? (this.redisClient.zCount(key, query.min, query.max))
        : new Promise<number>(resolve => resolve(-1)),
    ]);
    return {
      paging: {
        count: options.LIMIT?.count ?? -1,
        offset: options.LIMIT?.offset ?? 0,
        total:
          hasOffsetOrCount
            ? (typeof total === 'number' ? total : -1)
            : values.length,
      },
      rows: values.map(v => ({
        value: JSON.parse(v.value) as T,
        score: v.score,
      }))
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

async function zRange(redisClient: redis.RedisClientType | redis.RedisClusterType, withScore: boolean, key: string, min: number, max: number, options: any) {
  if (withScore) {
    return redisClient.zRangeWithScores(key, min, max, options)
  }
  else {
    const result = await redisClient.zRange(key, min, max, options);
    return result.map(r => ({
      value: r,
      score: undefined,
    }));
  }
}
