/**
 * Sorted Set database
 *
 * Stores a set of values, sorted by order number.
 *
 * For each value, only one copy will be stored in the set. It can be either the one with the
 * largest or lower score (depending on the insertion operation used).
 */
export interface SSetDB {

  /**
   * Process a batch of SSet operation in a single transaction.
   *
   * Either all should process successfully or it should fail.
   */
  process<T>(op: SSetOp<T>[]): Promise<any>;

  /**
   * Return elements in a sorted set from a range of indices.
   *
   * Negative indices indicates elements counting from the end (-1 is the last element).
   * min and max are included.
   */
  rangeByIndex<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>>;

  /**
   * Return elements in a sorted set from a range of scores.
   *
   * min and max are included.
   */
  rangeByScore<T>(db: string, id: string[], query: SSetRangeQuery): Promise<SSetRangeResponse<T>>;
}

/**
 * A query to retrieve data from a Sorted Set.
 */
export type SSetRangeQuery = {

  /** Index or score of the first element to retrieve, included. Use negative indices to count entries from the end. */
  min: number;

  /** Index or score of the last element to retrieve, included. Use negative indices to count entries from the end. */
  max: number;

  /** Number of rows to skip in the response (optional) */
  offset?: number;

  /** Max number of rows to return in the response (optional) */
  count?: number;

  /** Retrieve elements in ascending or descending order (default: 'asc') */
  order?: 'asc' | 'desc';

  /** Include total number of rows in the paginated response.
   *
   * Might require an extra request if offset or limit are specified. */
  includeTotal?: boolean;
};

/**
 * Response from a Sorted Set query.
 */
 export interface SSetRangeResponse<T> {
  /** Paging information */
  paging: {
    /** Number of elements skipped */
    offset: number;
    /** Max number of elements requested */
    count: number;
    /** Total number of elements in the range */
    total: number;
  };
  /** List of elements */
  rows: T[];
}

/** When add an element to the set, it gets added only if its score is the highest of equal elements in the set.
 *
 * When keep is ALL_VALUES, the set will contain 1 element of each value. This is useful for creating an index, sorted by date for example.
 *
 * When keep is LAST_VALUE, the set will contain only 1 element: the one with the largest score. This is useful for example for keeping the last known state of an entity, by using a timestamp for the score.
 */
export type SSetKeepOption = "ALL_VALUES" | "LAST_VALUE";

/** Definition of a Sorted Set operation */
export type SSetOp<T> = {
  db: string;
  keep: SSetKeepOption;
  id: string[];
  score: number;
  value: T;
}

/** Create a sorted set operation definition using a short syntax */
export function sSetOp<T>(db: string, id: string[], score: number, value: T, keep: SSetKeepOption): SSetOp<T> {
  return { db, keep, id, score, value };
};

