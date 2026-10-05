/**
 * Key-Value database with optional per-entry expiry.
 *
 * Stores a single value per key. Writes whose expiresAt is already past are
 * silently skipped (see "already-expired is a no-op" in the KV contract).
 * Reads of absent or expired keys return undefined. Range and prefix scans
 * are not supported by this data type.
 */
export interface KVDB {

  /**
   * Apply a batch of KV write operations.
   *
   * Ops whose expiresAt is <= now at invocation time are silently skipped
   * (contract: "already-expired is a no-op"). Fractional expiresAt values
   * are floored to the whole second — the common `Date.now() / 1000 + ttl`
   * emitter pattern yields fractional values, and flooring them avoids
   * wedging the view indexer (an actual reject only happens on genuinely
   * malformed input: NaN, non-finite, negative, wrong type, or a missing id).
   * These surface loudly: batch validation runs before any write, so a
   * rejection never leaves the batch partially applied.
   *
   * Resolves when all surviving writes have been acknowledged by the backend.
   * Rejects if the backend is unavailable; the caller (typically the query
   * server) lets the rejection propagate so CouchDB retries the indexing task.
   */
  process<T>(ops: KVOp<T>[]): Promise<void>;

  /**
   * Point lookup. Returns undefined if the key is absent or expired.
   *
   * When includeExpiresAt is true (default), the returned entry includes the
   * absolute expiry time in unix seconds; this costs one extra Redis PTTL
   * round-trip per key. Set it to false to skip the PTTL when the caller
   * doesn't need the expiry timestamp.
   */
  get<T>(db: string, id: string[], options?: KVGetOptions): Promise<KVEntry<T> | undefined>;

  /**
   * Batch point lookup.
   *
   * Output array has the same length as `ids`; index N holds the entry for
   * `ids[N]`, or undefined if that key is missing/expired. Callers may filter
   * out the undefineds; preserving positions lets the supercouch.nano layer
   * match rows back to the input key list.
   */
  mget<T>(db: string, ids: string[][], options?: KVGetOptions): Promise<(KVEntry<T> | undefined)[]>;
}

/**
 * A single $KV write operation.
 *
 * `value` is serialized to JSON before storage (same convention as SSetOp.value).
 * `expiresAt` is unix seconds; absent means the key is persistent until
 * overwritten, past means the write is a silent no-op.
 */
export type KVOp<T> = {

  /** Logical database name. Used as the Redis cluster hash tag prefix. */
  db: string;

  /** Path components forming the key. At least one element required. */
  id: string[];

  /** The payload. JSON-serialized on write, JSON-parsed on read. */
  value: T;

  /** Absolute expiry, in unix seconds. Optional. Fractional values are
   *  floored to the whole second on write. */
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

  /** The stored payload. */
  value: T;

  /** Absolute expiry, in unix seconds. Present only for TTL'd keys. */
  expiresAt?: number;
};

/**
 * Options controlling a KV read.
 */
export type KVGetOptions = {

  /** When true (default), populate KVEntry.expiresAt by also issuing PTTL.
   * Setting this to false avoids the extra round-trip per key. */
  includeExpiresAt?: boolean;
};
