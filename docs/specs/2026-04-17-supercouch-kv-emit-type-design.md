# Design: SuperCouch `$KV` Emit Type

**Date:** 2026-04-17
**Related:** `docs/superpowers/specs/2026-04-15-request-content-redis-cache-design.md` (future-improvement section that motivated this), `docs/superpowers/specs/2026-04-15-supercouch-migration-design.md`
**Scope:** SuperCouch core only — the query server (`supercouch/src/supercouch.ts`), two new sibling packages (`lib/supercouch.kv/`, `lib/supercouch.kv.redis/`), and the client library (`lib/supercouch.nano/src/supercouch.nano.ts`). Events-view emitter typings and validator consumer changes are out of scope and will be designed in follow-up specs.

## Motivation

SuperCouch today exposes one data type: `$SSET` — a sorted-set backed by Redis. This covers range queries and "last known state" patterns, but not every caching need is a sorted set.

The REQUEST_CONTENT work (`2026-04-15-request-content-redis-cache-design.md`) landed a direct-to-Redis write path that bypasses SuperCouch entirely, because no SuperCouch data type fits the use case: "write a single value keyed by `(appName, reqId)` with a bounded lifetime, then read it once." That bypass added ~50 lines of dedicated write/read/routing code and made REQUEST_CONTENT the only cache entry that isn't a first-class SuperCouch emitter.

Adding `$KV` as a second data type — a single-valued, optionally TTL'd key — makes this pattern a first-class SuperCouch emit. REQUEST_CONTENT (and any future time-bounded cache entry) becomes a normal emitter: the dDoc's map function emits the value, the CouchDB view indexer routes it to Redis, and callers read it via `db.view`.

This spec covers only the SuperCouch-side additions needed to make that possible. It does not migrate REQUEST_CONTENT itself — that happens in a follow-up once `$KV` is deployed.

## Contract

`$KV` is a new SuperCouch data type. Its user-visible contract is:

- **Write.** A document's map function emits a key starting with `"$KV"` and a value payload `{ value, expiresAt? }`. SuperCouch stores the value at that key.
- **Single value per key.** If the same key is emitted from two different documents, behavior at the indexing layer is **undefined** (last-write-wins in the current Redis backend, but callers must not rely on it).
- **TTL.** If `expiresAt` (unix seconds) is provided and in the future, the key is readable until that instant, then gone.
- **Persistent.** If `expiresAt` is absent, the key persists until overwritten.
- **Already-expired is a no-op.** If `expiresAt` is at or before "now" at indexing time, the emit is silently skipped (no key written, no log entry). The contract "value exists until `expiresAt`" is honored by not writing a key whose lifetime is already zero. This matters operationally: full re-indexes of an events database will replay millions of long-past REQUEST_CONTENT emits; logging them would be catastrophic and writing them would create garbage that Redis immediately purges.
- **Read.** Callers retrieve a value via `db.view(ddoc, view, { key: ["$KV", db, ...id], limit: 1 })` or, for batch lookups, `{ keys: [...] }`. Zero or one logical value is returned per key. Missing and expired keys are treated identically: the row is simply not in the response.
- **No range reads.** `startkey` / `endkey` with a `$KV` marker throws `"$KV: range queries not supported"`. Callers that need range scans must dual-emit to a normal CouchDB view (a caller-side decision, outside SuperCouch).
- **No deletion.** Callers rely on TTL or overwrite.

The storage backend (Redis in v1) is an implementation detail. A future `KVCouchDB` or `KVSqlite` could replace `KVRedis` without callers noticing.

### Why `expiresAt` (unix seconds) rather than ISO 8601 or relative TTL

- **Idempotent across re-indexes.** A CouchDB view replay produces the same key, same value, and same `expiresAt`. A relative TTL (`{ ttl: 3600 }`) would shift expiry forward on every re-index, eventually persisting documents that should have expired.
- **Performance.** SuperCouch sits on the hot path of the view indexer and of reads. No ISO-8601 parsing per emit.
- **Consistent with the existing SSet public API**, which uses `score: number` (typically a unix timestamp) — no date type has been introduced.

## Architecture

### Module layout

Two new packages mirror the SSet pair exactly:

```
lib/supercouch.kv/
├── package.json              name: "supercouch.kv", version: "0.1.0"
├── tsconfig.json             (copy of supercouch.sset/tsconfig.json)
├── src/
│   ├── index.ts              export * from './kv.db';
│   └── kv.db.ts              KVDB, KVOp, KVEntry, KVGetOptions
└── dist/                     (generated)

lib/supercouch.kv.redis/
├── package.json              name: "supercouch.kv.redis", version: "0.1.0",
│                             devDep: "supercouch.kv": "^0.1.0", "redis": "^4.x"
│                             peerDep: "redis": "*"
├── tsconfig.json             (copy of supercouch.sset.redis/tsconfig.json)
├── src/
│   ├── index.ts              export * from './kv.redis';
│   └── kv.redis.ts           KVRedis implements KVDB
└── dist/                     (generated)
```

The top-level `supercouch` package adds both as `devDependencies`. `src/supercouch.ts` imports them the same way it imports the SSet pair.

**Why two separate packages rather than folding KV into `supercouch.sset` / `supercouch.sset.redis`:** SuperCouch is a framework of swappable data-type modules on top of swappable backends. `$SSET` and `$KV` have different contracts (single value vs sorted set, optional TTL vs score, no range vs range), and a future `$RELATION` (SQL-backed) should slot in the same way. One data type, one package; one backend, one package. This keeps each surface tight and lets operators swap backends per data type if ever needed.

### Interfaces (`lib/supercouch.kv/src/kv.db.ts`)

```typescript
/**
 * Key-Value database with optional per-entry expiry.
 *
 * Stores a single value per key. Writes whose expiresAt is already past are
 * silently skipped. Reads of absent or expired keys return undefined.
 * Range / prefix scans are not supported by this data type.
 */
export interface KVDB {
  /**
   * Apply a batch of KV write operations.
   *
   * Ops whose expiresAt is <= now at invocation time are silently skipped
   * (see contract: "already-expired is a no-op").
   *
   * Resolves when all surviving writes have been acknowledged by the backend.
   * Rejects if the backend is unavailable; the caller (typically the query
   * server) lets the rejection propagate so CouchDB retries the indexing task.
   */
  process<T>(ops: KVOp<T>[]): Promise<void>;

  /**
   * Point lookup. Returns undefined if the key is absent or expired.
   */
  get<T>(db: string, id: string[], options?: KVGetOptions): Promise<KVEntry<T> | undefined>;

  /**
   * Batch point lookup. Output array has the same length as `ids`; index N
   * holds the entry for `ids[N]`, or undefined if that key is missing/expired.
   * Callers may filter out the undefineds; preserving positions lets the
   * supercouch.nano layer match rows back to the input key list.
   */
  mget<T>(db: string, ids: string[][], options?: KVGetOptions): Promise<(KVEntry<T> | undefined)[]>;
}

/**
 * A single $KV write operation.
 *
 * `value` is serialized to JSON before storage (same as SSetOp.value).
 * `expiresAt` is unix seconds; absent = persistent, past = silent skip.
 */
export type KVOp<T> = {
  db: string;
  id: string[];
  value: T;
  expiresAt?: number;
};

/**
 * A single $KV read result.
 *
 * `expiresAt` (unix seconds) is populated only when the caller requested it
 * (default) AND the stored key has a TTL. Persistent keys (no TTL) omit the
 * field.
 */
export type KVEntry<T> = {
  value: T;
  expiresAt?: number;
};

/**
 * Options controlling a KV read.
 *
 * `includeExpiresAt` (default: true) populates KVEntry.expiresAt. Setting it
 * to false skips the PTTL round-trip for performance-sensitive callers that
 * don't need the expiry timestamp.
 */
export type KVGetOptions = {
  includeExpiresAt?: boolean;
};
```

### Redis backend (`lib/supercouch.kv.redis/src/kv.redis.ts`)

**Key format:** `{KV:<db>}/<encodeURIComponent(id[0])>:<encodeURIComponent(id[1])>:...`

Mirrors `SSetRedis.key()` byte-for-byte except for the `KV` marker. Two properties:
- `{KV:<db>}` is a Redis cluster hash tag, pinning all keys in one `db` to a single slot. Writes for the same `db` stay pipelined on one node, matching `SSetRedis.process()`'s shape.
- `$KV` and `$SSET` entries with identical `(db, id)` do not collide (different markers).

**Value encoding:** `JSON.stringify(op.value)` on write, `JSON.parse(raw)` on read. Same as SSet.

**Write (`process`):**

```typescript
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
    (groups[op.db] ??= []).push(op);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const promises = Object.entries(groups).map(([_db, dbOps]) => {
    let multi = this.redisClient.multi();
    let wrote = false;
    for (const op of dbOps) {
      if (op.expiresAt !== undefined && op.expiresAt <= nowSec) {
        continue; // silent skip — per contract, no log, no error
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
```

Validation runs **before** the expiry check — a malformed `expiresAt` is an emiter bug worth surfacing loudly, whereas an already-past valid `expiresAt` is a legitimate no-op.

**Read (`get` / `mget`):**

```typescript
async get<T>(db: string, id: string[], options?: KVGetOptions): Promise<KVEntry<T> | undefined> {
  const key = KVRedis.key(db, id);
  if (options?.includeExpiresAt === false) {
    const raw = await this.redisClient.get(key);
    return raw == null ? undefined : { value: JSON.parse(raw) as T };
  }
  // Pipeline GET + PTTL in one round-trip to avoid a TTL/GET race.
  const [raw, pttlMs] = await this.redisClient.multi().get(key).pTTL(key).exec() as [string | null, number];
  if (raw == null) return undefined;        // PTTL returns -2 for absent keys
  const value = JSON.parse(raw) as T;
  if (pttlMs === -1) return { value };      // persistent
  return { value, expiresAt: Math.floor(Date.now() / 1000 + pttlMs / 1000) };
}

async mget<T>(db: string, ids: string[][], options?: KVGetOptions): Promise<(KVEntry<T> | undefined)[]> {
  if (!ids.length) return [];
  const keys = ids.map(id => KVRedis.key(db, id));
  if (options?.includeExpiresAt === false) {
    // One MGET round-trip.
    const raws = await this.redisClient.mGet(keys);
    return raws.map(raw => raw == null ? undefined : { value: JSON.parse(raw) as T });
  }
  // Pipeline N × (GET + PTTL) in one round-trip. All keys share the {KV:<db>} hash tag,
  // so the MULTI stays on a single cluster slot.
  let multi = this.redisClient.multi();
  for (const k of keys) { multi = multi.get(k).pTTL(k); }
  const results = await multi.exec() as (string | null | number)[];
  const nowSec = Math.floor(Date.now() / 1000);
  return ids.map((_id, i) => {
    const raw = results[i * 2] as string | null;
    const pttlMs = results[i * 2 + 1] as number;
    if (raw == null) return undefined;
    const value = JSON.parse(raw) as T;
    if (pttlMs === -1) return { value };
    return { value, expiresAt: Math.floor(nowSec + pttlMs / 1000) };
  });
}
```

Clock-skew caveat: the silent-skip check uses the query-server host's clock (the CouchDB host, not Redis). NTP drift is sub-second in practice; for a contract phrased in seconds this is acceptable.

### Query server (`src/supercouch.ts`)

Two new things:

1. **Constants.** Add `const KV_KEY = '$KV';` alongside `SSET_KEY`.

2. **Global KV backend.** At startup, after `sSetDB = new SSetRedis(client)`, also `kvDB = new KVRedis(client)` using the **same** Redis client — no new CLI flag, no new Redis connection. If a future deployment needs a dedicated KV cluster, add `--kv-redis-url` then.

3. **Emit dispatch in `mapDoc()`.** Two parallel filters (Approach A from the brainstorm — not a unified registry):

```typescript
const ssetOps: SSetOp<any>[] = [];
const kvOps: KVOp<any>[] = [];
const ret: any[] = [];

emits.forEach(kv => {
  let shouldEmit = true;
  if (kv?.[0]?.length >= 3 && typeof kv[0][0] === 'string') {
    const [marker, db, ...id] = kv[0] as string[];
    if (marker === SSET_KEY && typeof kv[1] === 'object') {
      const { value, score, keep } = kv[1];
      if (keep && db && id && typeof score === 'number') {
        ssetOps.push({ keep, db, id, score, value });
        shouldEmit = config.emitSSet;
      }
    } else if (marker === KV_KEY && typeof kv[1] === 'object') {
      const { value, expiresAt } = kv[1];
      if (db && id) {
        kvOps.push({ db, id, value, expiresAt });
        shouldEmit = config.emitKV ?? false;
      }
    }
  }
  if (shouldEmit) ret.push(kv);
});

emits = [];
await Promise.all([
  ssetOps.length ? sSetDB.process(ssetOps) : Promise.resolve(),
  kvOps.length ? kvDB.process(kvOps) : Promise.resolve(),
]);
return ret;
```

A new `--emit-kv` CLI flag mirrors `--emit-sset` for the same backup-rebuild use case (emit the `$KV` entries to the CouchDB view too, so the Redis DB can be rebuilt from the view if needed). Default off.

### Client library (`lib/supercouch.nano/src/supercouch.nano.ts`)

**Construction.** `supercouch(db, config)` builds both backends:

```typescript
const sSetDB = config.redisClient ? new SSetRedis(config.redisClient) : null;
const kvDB   = config.redisClient ? new KVRedis(config.redisClient)   : null;
if (!sSetDB || !kvDB) throw new Error('Please provide "redisClient" in supercouch config');
```

**Widened `DocumentViewParams`.** Add `include_expires_at?: boolean` (underscored to match nano / CouchDB convention, same as the existing `include_scores` / `include_total_rows`). Default `true`.

**Widened emit type (discriminated union on `key[0]`).** Replace the single `DocumentViewEmit<V>` with:

```typescript
export interface SSetEmit<V> {
  key: readonly ["$SSET", string, ...(string | number)[]];
  value: V;
  score: number;
  keep: SSetKeepOption;
}

export interface KVEmit<V> {
  key: readonly ["$KV", string, ...(string | number)[]];
  value: V;
  expiresAt?: number;
}

export type DocumentViewEmit<V> = SSetEmit<V> | KVEmit<V>;
```

TypeScript enforces the right per-prefix shape at the call site; the runtime dispatcher only inspects `key[0]`.

**`db.emit()` dispatch.** Walk the emits array, split into `SSetOp[]` and `KVOp[]` by `key[0]`, call `sSetDB.process()` / `kvDB.process()` in parallel:

```typescript
(ret as any).emit = async function<V>(_ddoc, _view, emits: DocumentViewEmit<V>[], callback?) {
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
      ssetOps.length ? sSetDB.process(ssetOps) : Promise.resolve(),
      kvOps.length ? kvDB.process(kvOps) : Promise.resolve(),
    ]);
    if (callback) process.nextTick(() => callback(null, 'ok'));
    return 'ok';
  } catch (err) {
    if (callback) process.nextTick(() => callback(err as Error, 'ok'));
    else throw err;
  }
};
```

**`db.view()` dispatch.** `getQueryType()` gains a `$KV` branch. The existing function returns `'keys' | 'range' | null`; add `'kv-keys'`:

```typescript
function getQueryType(qs) {
  // $SSET keys (batched point lookups — unchanged)
  if (qs.keys && qs.keys[0] && qs.keys[0][0] === '$SSET') return 'keys';

  // $KV keys (single or batched point lookups — new)
  if (qs.keys && qs.keys[0] && qs.keys[0][0] === '$KV') return 'kv-keys';
  if (qs.key && qs.key[0] === '$KV') return 'kv-keys';

  // $KV range — explicitly unsupported
  const startKey = qs.start_key || qs.startkey;
  const endKey   = qs.end_key   || qs.endkey;
  if (startKey?.[0] === '$KV' || endKey?.[0] === '$KV') {
    throw new Error('$KV: range queries not supported (use $SSET or a CouchDB view)');
  }

  // $SSET range — unchanged
  if (startKey && startKey[0] === '$SSET' && endKey) { /* existing logic */ }

  return null;
}
```

The `view()` switch adds:

```typescript
case 'kv-keys': {
  const keys: string[][] = params.keys ?? [params.key];
  const response = await processKVKeysQuery<V, D>(kvDB, keys, {
    includeExpiresAt: params.include_expires_at ?? true,
  });
  if (callback) process.nextTick(() => callback(null, response));
  return response;
}
```

Where `processKVKeysQuery` mirrors the mixed-db shape of the existing `processKeysQuery` (SSet also allows mixed `db` in one `keys` call, issuing one request per key):

```typescript
async function processKVKeysQuery<V, D>(
  kvDB: KVDB,
  keys: string[][],
  options: { includeExpiresAt: boolean },
): Promise<DocumentViewResponse<V, D>> {
  if (!keys.length) return { offset: 0, total_rows: 0, rows: [] };

  // Group keys by db so each mget stays on a single cluster slot.
  // Keep the original index so we can reassemble output in request order.
  const groups = new Map<string, { index: number; id: string[] }[]>();
  keys.forEach((k, index) => {
    if (k[0] !== '$KV' || k.length < 2) {
      throw new Error('$KV: invalid key in batch — ' + JSON.stringify(k));
    }
    const db = k[1];
    const id = k.slice(2) as string[];
    if (!groups.has(db)) groups.set(db, []);
    groups.get(db)!.push({ index, id });
  });

  // Fetch each group in parallel.
  const rowByIndex: (any | null)[] = new Array(keys.length).fill(null);
  await Promise.all(Array.from(groups.entries()).map(async ([db, items]) => {
    const entries = await kvDB.mget<V>(db, items.map(it => it.id), options);
    entries.forEach((entry, i) => {
      if (!entry) return;
      const { index } = items[i];
      rowByIndex[index] = {
        id: '$KV',
        key: keys[index] as unknown as string, // work around nano's typing (same as $SSET path)
        value: entry.value,
        ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
      };
    });
  }));

  const rows = rowByIndex.filter((r): r is NonNullable<typeof r> => r !== null);
  return { offset: 0, total_rows: rows.length, rows };
}
```

The extended `DocumentViewResponse` gains an optional `expiresAt?: number` field on each row (mirroring the existing optional `score?: number` for `$SSET`).

## Data flow

**Write path (CouchDB view indexer):**

```
CouchDB view indexer
  → query server (supercouch binary)
     → map_doc → user's map() → emit("$KV", db, ...id, { value, expiresAt? })
     → mapDoc() filters $SSET → SSetOp[], $KV → KVOp[]
     → Promise.all(sSetDB.process, kvDB.process)
       → KVRedis: group by db → MULTI(SET [EX ttl])
     → rest of emits returned to CouchDB as normal view rows
```

**Write path (validator-side pre-index, via `db.emit`):**

```
validator code
  → db.emit(ddoc, view, [{key: ["$KV", db, ...id], value, expiresAt?}, ...])
     → dispatcher splits by key[0] → kvDB.process(...)
        → KVRedis: same MULTI as above
```

**Read path (single key):**

```
db.view(ddoc, view, { key: ["$KV", db, ...id], limit: 1, include_expires_at: true })
  → getQueryType → 'kv-keys'
  → processKVKeysQuery([key], {includeExpiresAt: true})
     → kvDB.get(db, id, {includeExpiresAt: true})
        → KVRedis: pipeline GET + PTTL
  → DocumentViewResponse { rows: [{id:"$KV", key, value, expiresAt?}] | [] }
```

**Read path (batch):**

```
db.view(ddoc, view, { keys: [["$KV", db, id1...], ["$KV", db, id2...], ...] })
  → getQueryType → 'kv-keys'
  → processKVKeysQuery(keys, ...)
     → kvDB.mget(db, ids, ...)
        → KVRedis: one pipelined round-trip for all keys
  → missing/expired entries dropped, rows preserve input order
```

**Read path (range) — throws:**

```
db.view(..., { startkey: ["$KV", ...], endkey: ["$KV", ...] })
  → getQueryType throws "$KV: range queries not supported"
```

## Error handling

| Situation | Handling |
|---|---|
| Emit with `expiresAt` at or before "now" | Silent skip (per contract). No log. No error. |
| Emit with invalid `expiresAt` (NaN, non-finite, negative, wrong type) | Throw at `KVRedis.process()`. Batch does not partially apply. Same posture as `SSetRedis` throwing on missing `id`/`keep`. |
| Emit with missing `id` / empty `id` array | Throw (same as SSet). |
| Redis unavailable during `process()` | Rejected promise propagates up through `mapDoc()` → CouchDB retries the indexing task (existing SSet behavior; `$KV` inherits). |
| Redis unavailable during `get` / `mget` | Rejected promise propagates to the `db.view()` caller, who handles it like any other view error. |
| Key expires between `GET` and `PTTL` on the read path | Treated as missing (`undefined`). `PTTL` returns `-2` for absent keys; the read sees `raw == null` → returns `undefined`. |
| Range query on `$KV` | `getQueryType` throws `"$KV: range queries not supported"` before any Redis call. |
| Mixed `$SSET` + `$KV` keys in a single `db.view({keys})` call | Throw — one backend per view call, same isolation rule the dispatcher already enforces for `$SSET`. |
| Mixed `db` values across keys in one `$KV` batch | Allowed — `processKVKeysQuery` groups by `db` and issues one `mget` per group in parallel, matching how `$SSET` `processKeysQuery` already handles mixed dbs. |

No routine logging on the hot path. Errors that propagate are logged by the existing `superLog` in `processQuery()`.

## Testing

Unit tests colocate with each package (`lib/supercouch.kv.redis/test/`), matching the existing SSet test layout.

**`kv.redis.ts` coverage:**

1. **`process` semantics**
   - Write without `expiresAt` → key persistent (Redis `TTL = -1`).
   - Write with future `expiresAt` → `TTL` within ±1s of expected.
   - Write with `expiresAt <= now` → no key written, no error, no log.
   - Batch across multiple `db`s → all apply.
   - Invalid `expiresAt` (NaN, negative, non-number) → throws; batch does not partially apply (the MULTI for that db was never started).
   - Missing / empty `id` → throws.
2. **`get`**
   - Hit with persistent key → `{value}`, no `expiresAt`.
   - Hit with TTL → `{value, expiresAt}` within ±1s of expected.
   - Miss (absent) → `undefined`.
   - Miss (expired after write) → `undefined` (fake-timer or short-TTL test).
   - `includeExpiresAt: false` → no PTTL round-trip (verify via spy or `MONITOR`).
3. **`mget`**
   - Mixed hit/miss preserves positional alignment in the output array.
   - Empty input → `[]`.
   - All-miss input → array of `undefined`s.
4. **Key encoding**
   - `id` with URL-unsafe characters (`:`, `/`, `#`, spaces) round-trips.
   - `$KV` and `$SSET` with identical `(db, id)` do not collide (write to each, read from each; neither sees the other).

**Query server (`src/supercouch.ts`) coverage:**

- A dDoc emitting both `$SSET` and `$KV` from one `map_doc` → both backends receive their respective ops; remaining rows returned to CouchDB.
- `$KV` emit with `expiresAt` in the past → silently skipped, no row returned, no error.
- `--emit-kv` flag → `$KV` entries also appear in the returned view rows.

**Client library (`lib/supercouch.nano/`) coverage:**

- `db.view({key: ["$KV", ...]})` → hits `kvDB.get`; returns the expected row shape.
- `db.view({keys: [...]})` with mixed hit/miss → dropped misses, preserved order of hits.
- `db.view({keys: [...]})` with keys spanning multiple `db`s → each group fetched in parallel; output reassembled in request order.
- `db.view({startkey: ["$KV", ...]})` → throws.
- `db.view({keys: [["$SSET", ...], ["$KV", ...]]})` → throws.
- `db.emit([{key: ["$SSET", ...]}, {key: ["$KV", ...]}])` → both backends called; returns `"ok"`.

Integration tests (real CouchDB + real Redis + real dDoc) live at the validator level and are out of scope for this spec.

## Deployment

The query server protocol has no capability negotiation. An old supercouch binary encountering a `$KV` emit from a newer dDoc will treat it as a normal view row — the row is indexed into CouchDB's B-tree and **nothing is written to Redis**. Symptoms: reads via `db.view({key: ["$KV", ...]})` return empty; no crash, no error. This is a silent failure mode.

**Rollout order is mandatory:**

1. Publish `supercouch.kv@0.1.0` and `supercouch.kv.redis@0.1.0` to npm.
2. Bump top-level `supercouch` to `1.1.0`, update `package.json` to depend on the two new packages, build, tag `v1.1.0`, push.
3. Run the Ansible playbook (`iapster/couchdb/supercouch.yml`) — `serial: 1` brings each CouchDB node to the new binary, with `service couchdb restart` after each.
4. **Only after all nodes run v1.1.0+**, deploy any dDoc that emits `$KV`.

**Verification after step 3** (before proceeding to step 4): on each CouchDB node, confirm `/opt/supercouch/package.json` reports `"version": "1.1.0"` (or higher). Operator-driven check; not automated today.

No new CLI flags or env vars are required for the default deployment. `$KV` reuses the existing `--redis-url` Redis client. A `--kv-redis-url` override could be added later if a deployment ever wants a dedicated KV cluster; not in scope for v1.

A `--emit-kv` flag is added (mirroring the existing `--emit-sset`) for the same backup-rebuild pattern. Default off.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Old binary receives `$KV` emit before upgrade complete | Silent failure: row indexed into B-tree, not Redis; reads return empty | Mandatory rollout order (binary first, dDoc second). Post-step-3 version check. |
| Re-index replays millions of long-past `expiresAt` emits | If logged or written, flood of garbage | Silent-skip path is the only path for expired emits — no log, no Redis write. |
| Relative TTL would make re-indexes extend expiry forever | Stale phantom keys | Chose absolute `expiresAt` (unix seconds) for idempotency. |
| Two docs emit the same `$KV` key | Last-write-wins; could be wrong | Contract states behavior is undefined; emitter authors responsible for key uniqueness (typically `(appName, reqId)`). |
| Clock skew between CouchDB host and Redis host | Silent-skip boundary off by sub-second | NTP drift is sub-second; contract granularity is seconds. Acceptable. |
| `PTTL` round-trip doubles Redis read cost when expiry is requested | ~2x latency on read path | `includeExpiresAt: false` option skips it; default is true because most callers want to know. |
| `$KV` and `$SSET` key collision | Two different data types write to the same Redis key | Key format uses distinct markers (`{KV:...}` vs `{SSET:...}`) — no possible collision. |
| Future backend (e.g., `KVCouchDB`) doesn't support `mget` atomically | Batched reads see skewed snapshots | Contract doesn't promise atomic batches; callers treat each row independently. |
| No capability negotiation in the protocol | Can't auto-detect which nodes support `$KV` | Documented sequencing rule + post-deploy version check. If fleet grows or emit types proliferate, revisit with a capabilities endpoint. |

## Open questions

None at design time. All architectural decisions are resolved.

## Out of scope for this spec

- Migrating REQUEST_CONTENT from the dedicated `preIndexRequestContent` path to a `$KV` emitter (follow-up spec: adds the `SuperKVKey` type in `events-view/src/types/emit.ts`, updates `createEmitWithSupercouchPrefix` to handle `$KV` prefixes, replaces `preIndexRequestContent` with a normal emitter, removes the Redis-direct read path in `get-request-content.ts`, removes the kill switch).
- Any further data types (`$RELATION`, etc.).
- Automated post-deploy version verification.
- Dedicated KV Redis cluster (`--kv-redis-url`).
