import { describe, it } from 'mocha';
import * as assert from 'assert';
import * as redis from 'redis';
import { SSetOp } from 'supercouch.sset';
import { SSetRedis } from '../src/index';

/** Recorded command issued against a MULTI transaction under test. */
interface RecordedCommand {
  command: string;
  args: unknown[];
}

/** Minimal stand-in for a redis Multi object: chains and records issued commands. */
interface RecordedMulti {
  zAdd(key: string, obj: { score: number; value: string }, opts: object): RecordedMulti;
  zRemRangeByRank(key: string, min: number, max: number): RecordedMulti;
  exec(): Promise<unknown[]>;
}

/** Builds a MULTI recorder: each zAdd/zRemRangeByRank call is recorded and chained. */
function recordMulti(): { multi: RecordedMulti; commands: RecordedCommand[] } {
  const commands: RecordedCommand[] = [];
  const multi: RecordedMulti = {
    zAdd(key: string, obj: { score: number; value: string }, opts: object) {
      commands.push({ command: 'ZADD', args: [key, obj.score, obj.value, opts] });
      return multi;
    },
    zRemRangeByRank(key: string, min: number, max: number) {
      commands.push({ command: 'ZREMRANGEBYRANK', args: [key, min, max] });
      return multi;
    },
    exec: () => Promise.resolve([`OK(${commands.length})`]),
  };
  return { multi, commands };
}

/** Lists the distinct cluster hash tags ({...}) of the ZADDs in a transaction. */
function distinctHashTags(commands: RecordedCommand[]): string[] {
  const tags = commands
    .filter(c => c.command === 'ZADD')
    .map(c => (c.args[0] as string).match(/\{[^}]+\}/)![0])
    .sort();
  return tags.filter((tag, i) => i === 0 || tag !== tags[i - 1]);
}

/** Test $SSET ops for one db (the db string becomes part of the cluster hash tag). */
function opsFor(db: string, count: number): SSetOp<{ v: number }>[] {
  return Array.from({ length: count }, (_, i): SSetOp<{ v: number }> => ({
    db,
    id: ['ID' + i],
    score: i,
    value: { v: i },
    keep: 'LAST_VALUE',
  }));
}

/** Runs process() on a stubbed client and returns every transaction's commands. */
async function runProcess(ops: SSetOp<unknown>[]): Promise<RecordedCommand[][]> {
  const transactions = [recordMulti(), recordMulti()];
  let call = 0;
  const client = {
    // SSetRedis uses only the multi() method; structurally stubbed.
    multi: () => transactions[call++].multi,
  };
  const sset = new SSetRedis(client as unknown as redis.RedisClientType);
  await sset.process(ops);
  return transactions.slice(0, call).map(t => t.commands);
}

describe('SSetRedis.process', () => {
  describe('with ops spanning multiple dbs', () => {
    function twoDbsOps(): SSetOp<{ v: number }>[] {
      return [...opsFor('prefix.1/myApp', 2), ...opsFor('prefix.1/otherApp', 2)];
    }

    it('issues one MULTI per db', async () => {
      const multiPerCall = await runProcess(twoDbsOps());
      assert.strictEqual(multiPerCall.length, 2);
    });

    it('each MULTI touches only one cluster hash tag', async () => {
      const multiPerCall = await runProcess(twoDbsOps());
      for (const commands of multiPerCall) {
        const tags = distinctHashTags(commands);
        assert.strictEqual(tags.length, 1, 'a MULTI spans several cluster hash tags: ' + JSON.stringify(tags));
      }
    });

    it('each MULTI contains only the ops of its own db', async () => {
      const multiPerCall = await runProcess(twoDbsOps());
      const tagsPerMulti = multiPerCall.map(distinctHashTags).flat().sort();
      assert.deepStrictEqual(tagsPerMulti, [
        '{SSET:prefix.1/myApp}',
        '{SSET:prefix.1/otherApp}',
      ]);
    });

    it('executes each op exactly once, not once per db group', async () => {
      const ops = twoDbsOps();
      const multiPerCall = await runProcess(ops);
      const totalZadds = multiPerCall
        .map(cmds => cmds.filter(c => c.command === 'ZADD').length)
        .reduce((a, b) => a + b, 0);
      assert.strictEqual(totalZadds, ops.length);
    });
  });

  describe('with ops for a single db', () => {
    it('issues a single MULTI holding all the ops', async () => {
      const multiPerCall = await runProcess([
        { db: 'db1', id: ['A'], score: 1, value: {}, keep: 'LAST_VALUE' },
        { db: 'db1', id: ['B'], score: 2, value: {}, keep: 'ALL_VALUES' },
      ]);
      assert.strictEqual(multiPerCall.length, 1);
      assert.deepStrictEqual(
        multiPerCall[0].map(c => c.command),
        ['ZADD', 'ZREMRANGEBYRANK', 'ZADD']);
    });
  });

  describe('with an unsupported keep option', () => {
    it('throws while building the transaction: the error matches the op, EXEC is skipped', () => {
      const { multi } = recordMulti();
      const client = { multi: () => multi };
      const sset = new SSetRedis(client as unknown as redis.RedisClientType);
      // keep: "NOPE" is not a valid SSetKeepOption. The validation runs while
      // building the transaction, so the throw is synchronous and EXEC never runs.
      const invalidOp = { db: 'db1', id: ['A'], score: 1, value: null, keep: 'NOPE' } as unknown as SSetOp<null>;
      assert.throws(
        () => sset.process([invalidOp]),
        /Unsupported value for \$SSET "keep" field: NOPE/);
    });
  });
});