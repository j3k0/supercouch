/**
 * Sorted Set database
 *
 * Stores a set of values, sorted by order number.
 *
 * For each value, only one copy will be stored in the set. It can be either the one with the
 * largest or lower score (depending on the insertion operation used).
 */
export interface SSetDB {

  /** Process a insertion operation */
  process<T>(op: SSetOp<T>): Promise<any>;

  /** Return the elements between index min and max (included) */
  rangeByIndex<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>>;

  /** Return the elements between scores min and max (included) */
  rangeByScore<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>>;

  /** Convenience, as it's equivalent to rangeByIndex(0, 0) */
  first<T>(db: string, id: string[]): Promise<T | null>;
  /** Convenience, as it's equivalent to rangeByIndex(-1, -1) */
  last<T>(db: string, id: string[]): Promise<T | null>;
}

export type SSetRangeQuery = {

  /** Min score or index (included) */
  min: number;

  /** Max score or index (included) */
  max: number;

  /** Number of rows to skip in the response (optional) */
  offset?: number;

  /** Max number of rows to return in the response (optional) */
  count?: number;

  /** Sorting order (default: 'asc') */
  order?: 'asc' | 'desc';

  /** Include total number of rows in the paginated response.
   *
   * Might require an extra request if offset or limit are specified. */
  includeTotal?: boolean;
};

export interface SSetRangeResponse<T> {
  paging: {
    offset: number;
    count: number;
    total: number;
  },
  rows: T[];
}

export type SSetOpType =

  /** Add an element to the set, only if its score is the highest of equal elements in the set.
   *
   * Keep 1 element of each value.
   *
   * This is useful for creating an index, sorted by date for example.  */
  | 'ADD'

  /** Add an element only if its score is the largest.
   *
   * Could as well be implemented with ADD and using negative scores.
   *
   * @deprecated Use ADD
   * @see ADD */
  | 'INSERT'

  /** Add an element only if its score is the largest in the whole set. Keep only 1 element in the set.
   *
   * This is useful for example for keeping the last known state of an entity, by using a timestamp for the score. */
  | 'KEEP_LAST'

  /** Add an element only if its score is the smallest in the whole set.
   *
   * Could as well be implemented with KEEP_LAST and using negative scores.
   *
   * @deprecated Use KEEP_LAST
   * @see KEEP_LAST */
  | 'KEEP_FIRST';

export type SSetOp<T> = {
  db: string;
  type: SSetOpType;
  id: string[];
  score: number;
  value: T;
}

export function sSetOp<T>(db: string, type: SSetOpType, id: string[], score: number, value: T): SSetOp<T> {
  return { db, type, id, score, value };
};

/** An array of Sorted Set operations. */
export class SSetOps {
  public all: SSetOp<any>[] = [];
  push<T>(op:SSetOp<T>|null|undefined) {
    if (op) this.all.push(op);
  }
  process(db: SSetDB):Promise<any> {
    return Promise.all(this.all.map(op => db.process(op)));
  }
}
