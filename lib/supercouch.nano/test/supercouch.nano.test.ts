import { describe } from 'mocha';
import * as td from 'testdouble';
import * as nano from 'nano';
import { RedisClientType } from '@node-redis/client';

import * as supercouch from '../src/index';
import * as assert from 'assert';

describe('supercouch', () => {
  it('extends a nano db object', () => {
    const db = td.object<nano.DocumentScope<any>>();
    const dbView = db.view;
    const redisClient = td.object<RedisClientType>();
    const dbx = supercouch.supercouch(db, { redisClient: redisClient as any });
    const dbxView = dbx.view;
    assert.ok(dbView != dbxView, 'view method has been extended');
  });
});

describe('.view', () => {
  function testbed() {
    const db = td.object<nano.DocumentScope<any>>();
    const dbView = db.view;
    const redisClient = td.object<RedisClientType>();
    const dbx = supercouch.supercouch(db, { redisClient: redisClient as any });
    return {db, dbView, redisClient, dbx};
  }

  it('detects keys queries', () => {
    const {dbx, dbView, redisClient} = testbed();
    dbx.view('designName', 'viewName', {
      keys: [["$SSET", "DB", "ID0"]],
    });
    td.verify((dbView as any)(), { ignoreExtraArgs: true, times: 0 });
    td.verify(redisClient.zRangeWithScores("{SSET:DB}/ID0", -1, -1), { ignoreExtraArgs: true, times: 1 });
  });

  it('detects range queries', () => {
    const {dbx, dbView, redisClient} = testbed();
    dbx.view('designName', 'viewName', {
      start_key: ["$SSET", "DB", "ID0", 11],
      end_key: ["$SSET", "DB", "ID0", 99],
    });
    td.verify((dbView as any)(), { ignoreExtraArgs: true, times: 0 });
    td.verify(redisClient.zRangeWithScores("{SSET:DB}/ID0", 11, 99, { BY: "SCORE" }), { ignoreExtraArgs: true, times: 1 });
  });

  it('passes on other requests to couchdb', () => {
    const {dbx, dbView, redisClient} = testbed();
    dbx.view('designName', 'viewName', {
      start_key: ["STUFF", "DB", "ID0", 11],
      end_key: ["STUFF", "DB", "ID0", 99],
    });
    td.verify((dbView as any)(), { ignoreExtraArgs: true, times: 1 });
    td.verify(redisClient.zRangeWithScores(td.matchers.anything(), td.matchers.anything(), td.matchers.anything()), { ignoreExtraArgs: true, times: 0 });
  });
});

describe('.view — $KV', () => {
  function testbed() {
    const db = td.object<nano.DocumentScope<any>>();
    const dbView = db.view;
    const redisClient = td.object<RedisClientType>();
    const dbx = supercouch.supercouch(db, { redisClient: redisClient as any });
    return {db, dbView, redisClient, dbx};
  }

  it('routes $KV point lookup (key param) to pipelined GET+PTTL, not to nano.view', async () => {
    const {dbx, dbView, redisClient} = testbed();
    // Stub multi().get().pTTL().exec() chain to return a hit.
    const multi: any = {
      get(_k: string) { return multi; },
      pTTL(_k: string) { return multi; },
      exec: () => Promise.resolve(['"hello"', 30_000]),
    };
    td.when((redisClient as any).multi()).thenReturn(multi);

    await dbx.view('designName', 'viewName', {
      key: ["$KV", "DB", "ID0"],
      limit: 1,
    } as any);

    td.verify((dbView as any)(), { ignoreExtraArgs: true, times: 0 });
    // multi() was called (pipeline path).
    td.verify((redisClient as any).multi(), { times: 1 });
  });

  it('routes $KV batch (keys param) to a single pipelined round-trip', async () => {
    const {dbx, dbView, redisClient} = testbed();
    const multi: any = {
      calls: [] as {m: string; args: any[]}[],
      get(k: string) { (multi.calls as any).push({m: 'get', args: [k]}); return multi; },
      pTTL(k: string) { (multi.calls as any).push({m: 'pTTL', args: [k]}); return multi; },
      exec: () => Promise.resolve(['"a"', -1, null, -2]),
    };
    td.when((redisClient as any).multi()).thenReturn(multi);

    const response: any = await dbx.view('designName', 'viewName', {
      keys: [["$KV", "DB", "a"], ["$KV", "DB", "missing"]],
    } as any);

    td.verify((dbView as any)(), { ignoreExtraArgs: true, times: 0 });
    // Two hits pipelined as GET+PTTL pairs → 4 calls.
    assert.strictEqual((multi as any).calls.length, 4);
    // Response drops the miss; keeps the hit.
    assert.strictEqual(response.rows.length, 1);
    assert.strictEqual(response.rows[0].value, 'a');
  });

  it('groups $KV batch keys by db — one mget call per db in parallel', async () => {
    const {dbx, dbView, redisClient} = testbed();
    let multiCount = 0;
    (redisClient as any).multi = () => {
      multiCount++;
      return {
        get(_k: string) { return this; },
        pTTL(_k: string) { return this; },
        exec: () => Promise.resolve(['"v"', -1]),
      };
    };

    await dbx.view('designName', 'viewName', {
      keys: [["$KV", "DB_A", "x"], ["$KV", "DB_B", "y"]],
    } as any);

    td.verify((dbView as any)(), { ignoreExtraArgs: true, times: 0 });
    // One multi() per db group.
    assert.strictEqual(multiCount, 2);
  });

  it('$KV range (startkey/endkey) throws synchronously', async () => {
    const {dbx} = testbed();
    await assert.rejects(
      () => dbx.view('designName', 'viewName', {
        start_key: ["$KV", "DB", "a"],
        end_key:   ["$KV", "DB", "z"],
      } as any),
      /range queries not supported/,
    );
  });

  it('include_expires_at: false skips the PTTL pipeline and uses MGET', async () => {
    const {dbx, redisClient} = testbed();
    td.when((redisClient as any).mGet(['{KV:DB}/x', '{KV:DB}/y']))
      .thenResolve(['"vx"', null]);

    const response: any = await dbx.view('designName', 'viewName', {
      keys: [["$KV", "DB", "x"], ["$KV", "DB", "y"]],
      include_expires_at: false,
    } as any);

    td.verify((redisClient as any).multi(), { times: 0 });
    assert.strictEqual(response.rows.length, 1);
    assert.strictEqual(response.rows[0].value, 'vx');
    assert.strictEqual(response.rows[0].expiresAt, undefined);
  });
});

describe('.emit — mixed $SSET + $KV', () => {
  function testbed() {
    const db = td.object<nano.DocumentScope<any>>();
    const redisClient = td.object<RedisClientType>();
    const dbx = supercouch.supercouch(db, { redisClient: redisClient as any });
    return {db, redisClient, dbx};
  }

  it('dispatches each emit to the correct backend by key[0]', async () => {
    const {dbx, redisClient} = testbed();

    // Stub multi() for both the SSet and KV pipelines (they each call multi()).
    let multiCount = 0;
    (redisClient as any).multi = () => {
      multiCount++;
      return {
        zAdd(_k: string, _v: any, _o: any) { return this; },
        zRemRangeByRank(_k: string, _a: number, _b: number) { return this; },
        set(_k: string, _v: string, _o?: any) { return this; },
        exec: () => Promise.resolve([]),
      };
    };

    const result = await (dbx as any).emit('designName', 'viewName', [
      { key: ["$SSET", "DB", "a"], value: 1, score: 10, keep: "LAST_VALUE" },
      { key: ["$KV", "DB", "b"],  value: 2 },
    ]);

    assert.strictEqual(result, 'ok');
    // At least two multi() calls (one per backend, each grouping by db).
    assert.ok(multiCount >= 2, `expected >= 2 multi() calls, got ${multiCount}`);
  });

  it('throws on unknown emit marker', async () => {
    const {dbx} = testbed();
    await assert.rejects(
      () => (dbx as any).emit('designName', 'viewName', [
        { key: ["$UNKNOWN", "DB", "x"], value: 1 },
      ]),
      /Unsupported emit marker/,
    );
  });
});
