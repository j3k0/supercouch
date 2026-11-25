/**
 * Integration test: the query server redacts credentials in its logs while
 * leaving the CouchDB reply channel (stdout) byte-identical.
 *
 * Covers the two things a pure-module test cannot see:
 *  - stdout is protocol output, not a log — a secret in a `$KV` value must come
 *    back untouched, or a `--emit-kv` rebuild would write redacted values.
 *  - the log file must not contain the secret, on every path (debug line dump,
 *    error context, raw-input echo).
 *
 * Needs a Redis reachable at SUPERCOUCH_TEST_REDIS_URL (default
 * redis://localhost:6379). Skipped when it is not reachable, so `npm test`
 * stays green on a machine without one.
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');

// Hand-written fixture only: a fake marker, no real data.
const SECRET = 'FAKE-INTEGRATION-SECRET-TOKEN';
const REDIS_URL = process.env.SUPERCOUCH_TEST_REDIS_URL || 'redis://localhost:6379';
const SERVER = path.join(__dirname, '..', 'build', 'supercouch.js');

/** @returns true when something accepts TCP connections at host:port. */
function canConnect(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** @returns the redis port from REDIS_URL. */
function redisPort() {
  try { return parseInt(new URL(REDIS_URL).port || '6379', 10); } catch (e) { return 6379; }
}

/**
 * Run the built query server over a set of protocol lines.
 * @returns {Promise<{stdout: string, log: string}>} raw reply bytes and log file.
 */
function runServer(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'supercouch-it-'));
  const logFile = path.join(dir, 'supercouch.log');
  const child = spawn(process.execPath, [
    SERVER, '--redis-url', REDIS_URL, '--log-file', logFile, '--debug', '--emit-kv',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('query server did not answer in time'));
    }, 15000);
    const finish = () => {
      clearTimeout(timer);
      // Give the log writes a tick to flush before reading the file.
      setTimeout(() => {
        const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
        rmSync(dir, { recursive: true, force: true });
        resolve({ stdout, log });
      }, 150);
    };
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', finish);

    // One reply expected for the map_doc line, then we close stdin.
    let answered = false;
    child.stdout.on('data', () => {
      if (answered) return;
      answered = true;
      child.stdin.end();
      setTimeout(() => child.kill(), 500);
    });

    for (const line of lines) child.stdin.write(line + '\n');
  });
}

test('CouchDB replies are not redacted, logs are', async t => {
  if (!await canConnect(redisPort())) {
    t.skip(`no redis at ${REDIS_URL}`);
    return;
  }

  const doc = {
    _id: 'unit-doc-1',
    type: 'unit',
    user: { id: 'unit-user', token: SECRET },
  };
  // A map function emitting the whole record as a $KV value, like the README's
  // `value: doc.user` example. The secret sits under a deny-listed key name.
  // The database name is namespaced so a rerun against a shared Redis cannot
  // clobber real data.
  // --emit-kv makes that value flow back out on stdout, which is the path a
  // rebuild of Redis uses.
  const mapFn = 'function map(doc){ if (doc.type === "unit") emit(["$KV","it:unitdb","it:unitid"], '
    + '{ value: doc.user, expiresAt: 0 }); }';

  const lines = [
    JSON.stringify(['reset', {}]),
    JSON.stringify(['add_fun', mapFn]),
    JSON.stringify(['map_doc', doc]),
  ];

  const { stdout, log } = await runServer(lines);

  // The protocol reply must carry the real value: a rebuild from these rows has
  // to reproduce what Redis holds.
  assert.ok(stdout.includes(SECRET), 'stdout reply keeps the real value');
  assert.ok(!stdout.includes('[redacted]'), 'stdout is never redacted');

  // The log must not carry it, on any path (debug line dump included).
  assert.ok(log.length > 0, 'log file was written');
  assert.ok(!log.includes(SECRET), 'log file carries no secret');
});

test('an oversized malformed line is truncated before it is echoed', async t => {
  if (!await canConnect(redisPort())) {
    t.skip(`no redis at ${REDIS_URL}`);
    return;
  }
  // A truncated document over the scrub cap: the JSON path fails, and the raw
  // echo to the log and to CouchDB must not carry the secret. The echo is
  // truncated first, which keeps it inside the scrub.
  const oversized = '{"_id":"unit-big","token":"' + SECRET + '","padding":"'
    + 'x'.repeat(70 * 1024);

  const { stdout, log } = await runServer([oversized]);

  assert.ok(!log.includes(SECRET), 'log file carries no secret');
  assert.ok(!stdout.includes(SECRET), 'error reply carries no secret');
  assert.ok(stdout.includes('parse_error'), 'still reports the parse error');
});
