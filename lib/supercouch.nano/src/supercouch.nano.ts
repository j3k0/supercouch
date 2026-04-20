import { SSetRedis } from "supercouch.sset.redis";
import type * as nano from "nano";
import type { RedisClientType, RedisClusterType } from "redis";
import { SSetDB, SSetKeepOption, SSetOp } from "supercouch.sset";
import { KVDB, KVOp } from "supercouch.kv";
import { KVRedis } from "supercouch.kv.redis";

export type SuperCouchConfig = {
  redisClient?: RedisClientType | RedisClusterType;
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

  /** Include the absolute expiry (unix seconds) for "$KV" documents.
   *
   * Costs one extra Redis PTTL round-trip per key. Set to false for
   * performance-sensitive callers that don't need the expiry timestamp.
   *
   * @default true */
  include_expires_at?: boolean;
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
    expiresAt?: number;
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

  /** Emits a document to a supercouch view.
   *
   * This is generally used to enrich an existing document, to cache stuff that otherwise would have to be computed from the global state.
   */
  emit<V>(
    designName: string,
    viewName: string,
    emits: DocumentViewEmit<V>[],
    callback?: nano.Callback<'ok'>
  ): Promise<'ok'>
}

export interface SSetEmit<V> {
  key: readonly ["$SSET", string, ...(string | number)[]];
  value: V;
  score: number;
  keep: SSetKeepOption;
}

export interface KVEmit<V> {
  key: readonly ["$KV", string, ...(string | number)[]];
  value: V;
  /** Optional absolute expiry in unix seconds. */
  expiresAt?: number;
}

export type DocumentViewEmit<V> = SSetEmit<V> | KVEmit<V>;

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
  const kvDB   = config.redisClient ? new KVRedis(config.redisClient)   : null;
  if (!sSetDB || !kvDB) throw new Error('Please provide "redisClient" in supercouch config');

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

    // Check if it's a supercouch query and process it. getQueryType can throw
    // synchronously ($KV range, mixed-marker keys batch); wrap so callback-style
    // callers still get their callback invoked instead of an unhandled rejection.
    let type: 'keys' | 'range' | 'kv-keys' | null;
    try {
      type = getQueryType(params);
    }
    catch (e) {
      const requestError: nano.RequestError = new Error('SuperCouch Failed: ' + (e as any).message);
      requestError.name = 'supercouch_error';
      requestError.reason = 'invalid_query';
      requestError.statusCode = 400;
      if (e instanceof Error) {
        requestError.stack = e.stack;
      }
      if (callback) {
        process.nextTick(() => callback(requestError, {} as DocumentViewResponse<V, D>));
        return undefined;
      }
      throw requestError;
    }
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
      case 'kv-keys': {
        try {
          const keys: string[][] = (params.keys as string[][]) ?? [(params as any).key as string[]];
          const includeExpiresAt = params.include_expires_at ?? true;
          const response = await processKVKeysQuery<V, D>(kvDB, keys, { includeExpiresAt });
          if (callback) process.nextTick(() => callback(null, response));
          return response;
        }
        catch (e) {
          const requestError: nano.RequestError = new Error('SuperCouch.KV Failed: ' + (e as any).message);
          requestError.name = 'supercouch_error';
          requestError.reason = 'kv_keys_query_failed';
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
  };

  (ret as any).emit = async function<V>(_designName: string, _viewName: string, emits: DocumentViewEmit<V>[], callback?: nano.Callback<'ok'>): Promise<'ok' | undefined> {
    try {
      const ssetOps: SSetOp<V>[] = [];
      const kvOps: KVOp<V>[] = [];
      for (const e of emits) {
        const [marker, db, ...id] = e.key;
        if (marker === '$SSET') {
          const s = e as SSetEmit<V>;
          ssetOps.push({ db, id: id as string[], keep: s.keep, score: s.score, value: s.value });
        } else if (marker === '$KV') {
          const k = e as KVEmit<V>;
          kvOps.push({ db, id: id as string[], value: k.value, expiresAt: k.expiresAt });
        } else {
          throw new Error('Unsupported emit marker: ' + marker);
        }
      }
      await Promise.all([
        ssetOps.length > 0 ? sSetDB.process(ssetOps) : Promise.resolve(),
        kvOps.length   > 0 ? kvDB.process(kvOps)    : Promise.resolve(),
      ]);
      if (callback) process.nextTick(() => callback(null, 'ok'));
      return 'ok';
    }
    catch (err) {
      if (callback)
        process.nextTick(() => callback(err as Error, 'ok'));
      else
        throw err;
    }
  };

  return ret;
}

/** Figure out the type of query based on the "keys" or "start_key" parameters.
 *
 * This doesn't support mixed types: a single view request will either go to SuperCouch's backend or to
 * CouchDB's native view. */
function getQueryType(qs: nano.DocumentViewParams): 'keys' | 'range' | 'kv-keys' | null {

  // Batch keys: all entries must share the same marker. Heterogeneous
  // markers are rejected since each marker routes to a different backend.
  if (qs.keys && qs.keys[0]) {
    const firstMarker = qs.keys[0][0];
    if (firstMarker === "$SSET" || firstMarker === "$KV") {
      for (let i = 1; i < qs.keys.length; ++i) {
        if (qs.keys[i]?.[0] !== firstMarker) {
          throw new Error('SuperCouch: mixed markers in a single keys batch are not supported (' + firstMarker + ' / ' + qs.keys[i]?.[0] + '). Split the query per marker.');
        }
      }
      return firstMarker === "$SSET" ? 'keys' : 'kv-keys';
    }
  }

  // $KV single point lookup via `key` param.
  const singleKey = (qs as any).key;
  if (singleKey && Array.isArray(singleKey) && singleKey[0] === "$KV")
    return 'kv-keys';

  // $KV range queries are explicitly unsupported.
  const startKey = qs.start_key || qs.startkey;
  const endKey   = qs.end_key   || qs.endkey;
  if ((startKey && startKey[0] === "$KV") || (endKey && endKey[0] === "$KV")) {
    throw new Error('$KV: range queries not supported (use $SSET or a CouchDB view)');
  }

  // $SSET range (unchanged)
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
  const keyRows = results.map((result, index) => {
    return {
      key: keys[index] as unknown as string, // getting around nano's incorrect typing
      row: result.rows[0]
    }
  });
  return {
    offset: 0,
    total_rows: keys.length,
    rows: keyRows.filter(kr => kr.row).map(kr => ({
      id: "$SSET",
      key: kr.key,
      value: kr.row.value,
      score: kr.row.score,
    })),
  };
}

async function processKVKeysQuery<V, D>(
  kvDB: KVDB,
  keys: string[][],
  options: { includeExpiresAt: boolean },
): Promise<DocumentViewResponse<V, D>> {
  if (!keys.length) return { offset: 0, total_rows: 0, rows: [] };

  // Group keys by db so each mget stays on a single Redis cluster slot.
  // Preserve the original index so output aligns with the request order.
  const groups = new Map<string, { index: number; id: string[] }[]>();
  keys.forEach((k, index) => {
    if (k[0] !== '$KV' || k.length < 3) {
      throw new Error('$KV: invalid key in batch — ' + JSON.stringify(k));
    }
    const db = k[1];
    const id = k.slice(2) as string[];
    if (!groups.has(db)) groups.set(db, []);
    groups.get(db)!.push({ index, id });
  });

  const rowByIndex: (any | null)[] = new Array(keys.length).fill(null);
  await Promise.all(Array.from(groups.entries()).map(async ([db, items]) => {
    const entries = await kvDB.mget<V>(db, items.map(it => it.id), options);
    entries.forEach((entry, i) => {
      if (!entry) return;
      const { index } = items[i];
      const row: any = {
        id: '$KV',
        key: keys[index] as unknown as string, // nano's typing expects string; this matches the $SSET path
        value: entry.value,
      };
      if (entry.expiresAt !== undefined) row.expiresAt = entry.expiresAt;
      rowByIndex[index] = row;
    });
  }));

  const rows = rowByIndex.filter((r): r is NonNullable<typeof r> => r !== null);
  return { offset: 0, total_rows: keys.length, rows };
}

async function processRangeQuery<V, D>(sSetDB: SSetDB, startKey: [...string[], number], endKey: [...string[], number], options: QueryOptions, skip?: number, limit?: number, descending?: boolean): Promise<DocumentViewResponse<V, D>> {
  const db = startKey[1] as string;
  const id = startKey.slice(2, -1) as string[];
  const key: (string | number)[] = ['$SSET', db, ...id]; // .join(',');
  const min = startKey[startKey.length - 1] as number;
  const max = endKey[endKey.length - 1] as number;
  const order = descending ? 'desc' : 'asc';
  const result = await sSetDB.rangeByScore<V>(db, id, { min, max, offset: skip, count: limit, order, includeTotal: options.withTotalRows, includeScores: options.withScores });
  return {
    offset: result.paging.offset,
    total_rows: result.paging.total,
    rows: result.rows.map(value => {
      return {
        id: '$SSET',
        key: (typeof value.score === 'number' ? key.concat(value.score) : key) as unknown as string, // nano's incorrect typing...
        value: value.value,
        score: value.score
      }
    }),
  };
}
