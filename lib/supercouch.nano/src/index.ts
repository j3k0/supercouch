import { SSetRedis } from "supercouch.sset.redis";
import type * as nano from "nano";
import type { RedisClientType } from "redis";
import { SSetDB } from "supercouch.sset";

export type SuperCouchConfig = {
  redisClient?: RedisClientType;
}

export interface DocumentViewResponse<V, D> extends nano.DocumentViewResponse<V, D> {
  /** Array of view row objects.
   *
   * By default the information returned contains only the document ID and revision. */
  rows: Array<{
    id: string;
    key: string;
    value: V;
    score?: number;
    doc?: D & nano.Document;
  }>;
}

/**
 * Extends a nano.db object with SuperCouch power
 *
 * @param db - nano database object
 * @param config - supercouch configuration
 *
 * @returns a nano database object with SuperCouch power
 */
export function supercouch<D>(db: nano.DocumentScope<D>, config: SuperCouchConfig) {

  const sSetDB = config.redisClient ? new SSetRedis(config.redisClient) : null;
  if (!sSetDB) throw new Error('Please provide either "redisClient" or "redisURL" in supercouch config');

  // nano's db.view method
  const db_view = db.view.bind(db);

  // Extended version of nano's db.view method
  (db as any).view = async function view<V>(ddoc: string, viewName: string, params: nano.DocumentViewParams, callback?: nano.Callback<DocumentViewResponse<V, D>>): Promise<DocumentViewResponse<V, D> | undefined> {

    // Check if it's a supercouch query and process it
    const type = getQueryType(params);
    switch (type) {
      case 'keys': {
        try {
          const response = await processKeysQuery<V, D>(sSetDB, params.keys as string[][]);
          if (callback) process.nextTick(() => callback(null, response));
          return response;
        }
        catch (e) {
          const requestError: nano.RequestError = new Error('SuperCouch.SSet Failed: ' + (e as any).message);
          requestError.name = 'supercouch_error';
          requestError.reason = 'keys_query_failed';
          requestError.statusCode = 500;
          if (e instanceof Error) {
            requestError.stack = e.stack;
          }
          if (callback)
            process.nextTick(() => callback(requestError, {} as DocumentViewResponse<V, D>));
          else
            throw requestError;
        }
      } break;
      case 'range': {
        try {
          const response = await processRangeQuery<V, D>(sSetDB, params.startkey || params.start_key, params.endkey || params.end_key, params.skip, params.limit);
          if (callback) process.nextTick(() => callback(null, response));
          return response;
        }
        catch (e) {
          const requestError: nano.RequestError = new Error('SuperCouch.SSet Failed: ' + (e as any).message);
          requestError.name = 'supercouch_error';
          requestError.reason = 'range_query_failed';
          requestError.statusCode = 500;
          if (e instanceof Error) {
            requestError.stack = e.stack;
          }
          if (callback)
            process.nextTick(() => callback(requestError, {} as DocumentViewResponse<V, D>));
          else
            throw requestError;
        }
      } break;
      default:
        return db_view<V>(ddoc, viewName, params, callback);
    }
  }
}

function getQueryType(qs: nano.DocumentViewParams) {

  // "keys", used to retrieve the latest state for a bunch of entities
  if (qs.keys && qs.keys[0] && qs.keys[0][0] === "$SSET")
    return 'keys';

  // "start_key" and "end_key", used to retrieve a range of value in a single key.
  const startKey = qs.start_key || qs.startkey;
  const endKey = qs.end_key || qs.endkey;
  if (startKey && startKey[0] === "$SET" && endKey) {
    if (startKey.length !== endKey.length) return null;

    // last element in the key is the min/max score
    if (typeof startKey[startKey.length - 1] !== 'number') return null;
    if (typeof endKey[endKey.length - 1] !== 'number') return null;

    // before the score, everything should be identical
    for (let i = 0; i < startKey.length - 1; ++i) {
      if (startKey[i] !== endKey[i]) return null;
    }
    return 'range';
  }
  return null;
}

async function processKeysQuery<V,D>(sSetDB: SSetDB, keys: string[][]): Promise<DocumentViewResponse<V, D>> {
  const promises = keys.map(key => {
    const [_marker, db, ...id] = key;
    return sSetDB.rangeByIndex<V>(db, id, { min: -1, max: -1, count: 1, includeScores: true });
  });
  const results = await Promise.all(promises);
  return {
    offset: 0,
    total_rows: keys.length,
    rows: results.map((result, index) => {
      const row = result.rows[0];
      return {
        id: '#SSET',
        key: keys[index].join(','),
        value: row.value,
        score: row.score,
      }
    }),
  };
}

export type ValueScoreResponse<T> = {
  value: T;
  score?: number;
}

async function processRangeQuery<V, D>(sSetDB: SSetDB, startKey: [...string[], number], endKey: [...string[], number], skip?: number, limit?: number, descending?: boolean): Promise<DocumentViewResponse<V, D>> {
  const db = startKey[1] as string;
  const id = startKey.slice(2, -1) as string[];
  const key = ['#SSET', db, ...id].join(',');
  const min = startKey[startKey.length - 1] as number;
  const max = startKey[endKey.length - 1] as number;
  const order = descending ? 'desc' : 'asc';
  const result = await sSetDB.rangeByScore<V>(db, id, { min, max, offset: skip, count: limit, order, includeTotal: true, includeScores: true });
  return {
    offset: result.paging.offset,
    total_rows: result.paging.total,
    rows: result.rows.map(value => {
      return { id: '#SSET', key, value: value.value, score: value.score }
    }),
  };
}
