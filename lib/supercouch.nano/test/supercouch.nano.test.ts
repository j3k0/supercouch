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
