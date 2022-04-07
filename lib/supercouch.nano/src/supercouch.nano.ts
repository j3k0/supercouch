import { SSetRedis } from "supercouch.sset.redis";
import type * as nano from "nano";
import type { RedisClientType } from "redis";
import { SSetDB } from "supercouch.sset";

export type SuperCouchConfig = {
  redisClient?: RedisClientType;
}

export interface DocumentViewParams extends nano.DocumentViewParams {
  /** Include the associated score for "$SSET" documents.
   *
   * The downside is a little more data to send over the wire, set this to false
   * to gain that extra bit of performance.
   *
   * @default true */
  include_scores?: boolean;

  /** Include the total number of rows.
   *
   * Might require an extra request.
   *
   * @default true */
  include_total_rows?: boolean;
}

/** View response.
 *
 * Extended to optionally include the score (for "$SSET" views).
 *
 * @see Docs: {@link http://docs.couchdb.org/en/latest/api/ddoc/views.html#get--db-_design-ddoc-_view-view} */
export interface DocumentViewResponse<V, D> extends nano.DocumentViewResponse<V, D> {
  /** @inheritdoc */
  rows: Array<{
    id: string;
    key: string;
    value: V;
    score?: number;
    doc?: D & nano.Document;
  }>;
}

/** Documents scope.
 *
 * Differs from nano.DocumentScope for view calls. Those can accept supercouch.DocumentViewParams
 * and return supercouch.DocumentViewResponse */
export interface DocumentScope<D> extends nano.DocumentScope<D> {

  /** @inheritdoc */
  view<V>(
    designName: string,
    viewName: string,
    callback?: nano.Callback<nano.DocumentViewResponse<V,D>>
  ): Promise<nano.DocumentViewResponse<V,D>>;

  /** @inheritdoc */
  view<V>(
    designName: string,
    viewName: string,
    params: DocumentViewParams,
    callback?: nano.Callback<DocumentViewResponse<V,D>>
  ): Promise<DocumentViewResponse<V,D>>;

  _couchView<V>(
    designName: string,
    viewName: string,
    params?: DocumentViewParams,
    callback?: nano.Callback<DocumentViewResponse<V,D>>
  ): Promise<DocumentViewResponse<V,D>>;
}

/**
 * Adds SuperCouch powers to a nano.db object
 *
 * @param db - nano database object
 * @param config - supercouch configuration
 *
 * @returns a nano database object with SuperCouch powers
 */
export function supercouch<D>(db: nano.DocumentScope<D>, config: SuperCouchConfig): DocumentScope<D> {

  const sSetDB = config.redisClient ? new SSetRedis(config.redisClient) : null;
  if (!sSetDB) throw new Error('Please provide either "redisClient" or "redisURL" in supercouch config');

  const ret = db as DocumentScope<D>;

  // nano's db.view method
  // const db_view = db.view;
  ret._couchView = db.view;

  // Extended version of nano's db.view method
  (ret as any).view = async function view<V>(ddoc: string, viewName: string, params?: DocumentViewParams, callback?: nano.Callback<DocumentViewResponse<V, D>>): Promise<DocumentViewResponse<V, D> | undefined> {

    if (typeof params === 'function' || !params) {
      return ret._couchView(ddoc, viewName, params, callback);
    }

    const options = {
      withScores: params.include_scores ?? true,
      withTotalRows: params.include_total_rows ?? true,
    };

    // Check if it's a supercouch query and process it
    const type = getQueryType(params);
    console.log(params, type);
    switch (type) {
      case 'keys': {
        try {
          const response = await processKeysQuery<V, D>(sSetDB, params.keys as string[][], options);
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
          const response = await processRangeQuery<V, D>(sSetDB, params.startkey || params.start_key, params.endkey || params.end_key, options, params.skip, params.limit, params.descending);
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
        // console.log("calling db_view");
        return ret._couchView<V>(ddoc, viewName, params, callback);
    }
  }
  return ret;
}

/** Figure out the type of query based on the "keys" or "start_key" parameters.
 *
 * This doesn't support mixed types: a single view request will either go to SuperCouch's backend or to
 * CouchDB's native view. */
function getQueryType(qs: nano.DocumentViewParams): 'keys' | 'range' | null {

  console.log({qs});

  // "keys", used to retrieve the latest state for a bunch of entities
  if (qs.keys && qs.keys[0] && qs.keys[0][0] === "$SSET")
    return 'keys';

  // "start_key" and "end_key", used to retrieve a range of value in a single key.
  const startKey = qs.start_key || qs.startkey;
  const endKey = qs.end_key || qs.endkey;
  if (startKey && startKey[0] === "$SSET" && endKey) {
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

type QueryOptions = {
  withScores: boolean;
  withTotalRows: boolean;
}

async function processKeysQuery<V, D>(sSetDB: SSetDB, keys: string[][], options: QueryOptions): Promise<DocumentViewResponse<V, D>> {
  const promises = keys.map(key => {
    const [_marker, db, ...id] = key;
    return sSetDB.rangeByIndex<V>(db, id, { min: -1, max: -1, includeScores: options.withScores, includeTotal: false });
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

async function processRangeQuery<V, D>(sSetDB: SSetDB, startKey: [...string[], number], endKey: [...string[], number], options: QueryOptions, skip?: number, limit?: number, descending?: boolean): Promise<DocumentViewResponse<V, D>> {
  const db = startKey[1] as string;
  const id = startKey.slice(2, -1) as string[];
  const key = ['#SSET', db, ...id].join(',');
  const min = startKey[startKey.length - 1] as number;
  const max = endKey[endKey.length - 1] as number;
  const order = descending ? 'desc' : 'asc';
  const result = await sSetDB.rangeByScore<V>(db, id, { min, max, offset: skip, count: limit, order, includeTotal: options.withTotalRows, includeScores: options.withScores });
  return {
    offset: result.paging.offset,
    total_rows: result.paging.total,
    rows: result.rows.map(value => {
      return { id: '#SSET', key, value: value.value, score: value.score }
    }),
  };
}
