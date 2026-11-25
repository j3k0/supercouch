/**
 * Unit tests: log lines never carry a private key or any other credential.
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { redact, redactLine, REDACTED, isSecretKey, LINE_SCRUB_LIMIT } = require('../build/log-redact.js');

// Hand-written fixtures only: fake markers, no real data.
const PRIVATE_KEY = 'FAKE-UNIT-PRIVATE-KEY';
const API_KEY = 'FAKE-UNIT-API-KEY';
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'unit-project',
  private_key_id: 'unit-key-id',
  private_key: PRIVATE_KEY,
  client_email: 'unit-service@unit-project.example.com',
});

/** A hand-written app record, shaped like the real one. */
const appRecord = () => ({
  _id: 'unit-app-1',
  type: 'app',
  apiKey: API_KEY,
  thirdPartyServiceAccount: SERVICE_ACCOUNT,
  webhookSecretKey: 'FAKE-UNIT-WEBHOOK',
});

function assertNoSecret(out) {
  assert.ok(!out.includes(PRIVATE_KEY), 'no private key');
  assert.ok(!out.includes(API_KEY), 'no api key');
  assert.ok(!out.includes('FAKE-UNIT-WEBHOOK'), 'no webhook secret');
}

test('redact() scrubs an app record at any depth', () => {
  const context = redact({ command: 'map_doc', args: [appRecord()] });
  const out = JSON.stringify(context);
  assertNoSecret(out);
  assert.ok(out.includes('unit-app-1'), 'non-secret fields survive');
});

test('redact() covers the error-context path (args holds the raw document object)', () => {
  const context = redact({
    command: 'map_doc',
    args: ['map_doc', appRecord()],
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  assertNoSecret(JSON.stringify(context));
});

test('redactLine() covers error messages that embed raw input', () => {
  assertNoSecret(redactLine(`Unexpected token in ${JSON.stringify(appRecord())}`));
});

test('redactLine() scrubs a JSON app record at any depth', () => {
  const line = JSON.stringify({ command: 'map_doc', app: appRecord() });
  const out = redactLine(line);
  assertNoSecret(out);
  assert.ok(out.includes('unit-app-1'), 'non-secret fields survive');
  assert.ok(out.includes(REDACTED));
});

test('redactLine() scrubs a raw key/value fragment (fallback path)', () => {
  const out = redactLine('parse error: input contains "private_key": "unit-raw-secret"');
  assert.ok(!out.includes('unit-raw-secret'));
  assert.ok(out.includes(REDACTED));
});

test('redactLine() covers hand-built fragments with deny-listed keys', () => {
  const out = redactLine('parse error input: {"_id":"a","thirdPartyServiceAccount":"unit-sa","other":"ok"}');
  assert.ok(!out.includes('unit-sa'));
  assert.ok(out.includes('ok'));
});

test('redactLine() scrubs bare (unquoted) values too', () => {
  const out = redactLine('input: {"private_key": 12345678, "other": 42}');
  assert.ok(!out.includes('12345678'), 'numeric secret is gone');
  assert.ok(out.includes('42'), 'innocent field survives');
});

test('redactLine() scrubs a value truncated before its closing quote', () => {
  const out = redactLine('input: {"api_key": "truncated-secret-no-end');
  assert.ok(!out.includes('truncated-secret-no-end'));
  assert.ok(out.includes(REDACTED));
});

test('redactLine() passes benign lines through untouched', () => {
  const line = '[supercouch] E/ 2026-01-01T00:00:00.000Z Error message: map function blew up';
  assert.strictEqual(redactLine(line), line);
});

test('redactLine() stays linear on backslash-heavy lines', () => {
  // Regression: the old regex backtracked superlinearly on long escaped runs
  // (tens of seconds for 0.6 MB). The scan must stay linear.
  const heavy = '"\\'.repeat(32 * 1024);
  const started = Date.now();
  const out = redactLine(heavy);
  const elapsed = Date.now() - started;
  assert.strictEqual(out, heavy, 'no secret, nothing to change');
  assert.ok(elapsed < 1000, `took ${elapsed} ms, expected linear behaviour`);
  // A secret after a long escaped run is still scrubbed when under the cap.
  const withSecret = redactLine(
    'input: {"big":"' + '\\"x'.repeat(4096) + '","private_key":"unit-heavy-secret"}');
  assert.ok(!withSecret.includes('unit-heavy-secret'), 'secret after escaped run is scrubbed');
});

test('redactLine() skips the scrub above LINE_SCRUB_LIMIT instead of stalling', () => {
  const huge = 'x'.repeat(LINE_SCRUB_LIMIT + 1) + ' "private_key": "unit-huge-secret"';
  const started = Date.now();
  const out = redactLine(huge);
  assert.strictEqual(out, huge, 'oversized line returned untouched, cheaply');
  assert.ok(Date.now() - started < 1000);
});

test('isSecretKey flags the usual credential field names', () => {
  assert.equal(isSecretKey('private_key'), true);
  assert.equal(isSecretKey('apiKey'), true);
  assert.equal(isSecretKey('thirdPartyServiceAccount'), true);
  assert.equal(isSecretKey('x-api-key'), true);
  assert.equal(isSecretKey('name'), false);
  assert.equal(isSecretKey('_id'), false);
});
