import { describe, it } from 'mocha';
import * as assert from 'assert';
import { KVRedis } from '../src/kv.redis';

describe('KVRedis.key', () => {

  it('encodes a simple (db, [id]) pair with the KV hash tag', () => {
    assert.strictEqual(KVRedis.key('mydb', ['abc']), '{KV:mydb}/abc');
  });

  it('joins multi-component ids with colons', () => {
    assert.strictEqual(KVRedis.key('mydb', ['abc', 'def', 'ghi']), '{KV:mydb}/abc:def:ghi');
  });

  it('URL-encodes components containing reserved characters', () => {
    // colons and slashes inside a component must be escaped so they don't
    // collide with the separator or the hash-tag delimiter.
    assert.strictEqual(KVRedis.key('mydb', ['a:b', 'c/d']), '{KV:mydb}/a%3Ab:c%2Fd');
  });

  it('URL-encodes spaces and non-ASCII bytes', () => {
    assert.strictEqual(KVRedis.key('mydb', ['a b', 'é']), '{KV:mydb}/a%20b:%C3%A9');
  });

  it('does not collide with $SSET keys for the same (db, id)', () => {
    // SSet uses {SSET:...}, KV uses {KV:...} — different hash tags, different keys.
    assert.notStrictEqual(KVRedis.key('mydb', ['abc']), '{SSET:mydb}/abc');
  });
});
