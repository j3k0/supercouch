/**
 * Log redaction for the supercouch query server.
 *
 * A CouchDB query server receives whole documents and echoes raw input lines
 * when something fails. Applications commonly store credentials inside those
 * documents (private keys, API keys, tokens, passwords), so writing them to a
 * log stream leaks them. Two layers:
 *  - `redact()`: callers apply it to an object *before* stringifying it into a
 *    log line (line-shaped debug logs, error contexts, output dumps). This is
 *    the reliable path: values are redacted at any depth of the object.
 *  - `redactLine()`: `superLog` safety net, applied to every line before it
 *    reaches syslog, the log file or stderr. Covers hand-built message lines
 *    that embed a raw fragment of the input.
 *
 * This is a deny-list on key names: it cannot catch a secret stored under an
 * innocent key. Keep those out of log calls by hand.
 *
 * The CouchDB reply channel (stdout, see `respond()`) is protocol output, not a
 * log: never redact there, or view rows stop matching what was written to Redis.
 */

/** Value written in place of a redacted value. */
export const REDACTED = '[redacted]';

/**
 * Key names whose values must never be logged. Matched case-insensitively with
 * `-` / `_` / nothing between words allowed (`private_key`, `privateKey`,
 * `x-api-key`, `refresh_token`). Covers the usual credential field families:
 * secrets and passwords, tokens, API keys, shared keys, private keys, license
 * keys, purchase keys, service accounts, credentials, cookies and
 * authorization headers.
 */
const DENY_KEY = /secret|pass(word|wd)|token|api[-_]?key|shared[-_]?key|private[-_]?key|in[-_]?app[-_]?purchase[-_]?key|license[-_]?key|service[-_]?account|credential|cookie|authorization/i;

/** @returns true when the value stored under `key` must be redacted. */
export function isSecretKey(key: string): boolean {
  return DENY_KEY.test(key);
}

/**
 * Build a `JSON.stringify` replacer. A new one is needed per record: it tracks
 * the objects being walked to break cycles.
 */
export function createReplacer(): (this: any, key: string, value: any) => any {
  /** Objects between the root and the value being visited. */
  const ancestors: any[] = [];
  return function (this: any, key: string, value: any) {
    if (value !== null && value !== undefined && isSecretKey(key)) return REDACTED;
    if (typeof value !== 'object' || value === null) return value;
    // `this` is the object holding `value`: drop the branches already left.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return '[Circular]';
    ancestors.push(value);
    return value;
  };
}

/** @returns a copy of `value` with secrets redacted at any depth. Never throws. */
export function redact<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  try {
    const out = JSON.parse(JSON.stringify(value, createReplacer()));
    return out === undefined ? (REDACTED as unknown as T) : out;
  } catch (e) {
    return REDACTED as unknown as T;
  }
}

/**
 * Above this length the regex fallback is skipped.
 *
 * `superLog` runs on every line, single-threaded, and a document carrying long
 * escaped runs (a big escaped-JSON field, a path list) makes a backtracking
 * regex superlinear — a 0.6 MB line of `"\` took tens of seconds. Such a line
 * is a whole document, not a hand-built message: it is covered by the
 * `JSON.parse` path above when it is valid JSON, and by object-level `redact()`
 * at the call sites that matter. Skipping keeps the query server responsive.
 */
export const LINE_SCRUB_LIMIT = 64 * 1024;

/**
 * Redact a log line.
 *
 * When the line itself parses as JSON (a stringified command or error context),
 * re-stringify it with the deny-list replacer — secrets are redacted at any
 * depth. Otherwise fall back to a linear scan for `"secret-key": "value"`
 * pairs, for message lines that embed a raw fragment of the input. Only pairs
 * whose key and value are directly quoted are touched: redaction cannot cross
 * an escaped string boundary, so a fragment of valid JSON is always scrubbed
 * exactly where its secrets sit.
 *
 * The scan is linear in the line length — one pass, no backtracking — so a
 * hostile or merely large line cannot pin the process.
 */
export function redactLine(line: string): string {
  if (line[0] === '{' || line[0] === '[') {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, createReplacer());
    } catch (e) { /* fall through to the scan */ }
  }
  if (line.length > LINE_SCRUB_LIMIT) return line;
  return scrubPairs(line);
}

/**
 * Read the JSON string literal starting at `start` (a `"`), honouring `\`
 * escapes. @returns the index just past its closing quote, or -1.
 */
function endOfString(line: string, start: number): number {
  for (let i = start + 1; i < line.length; ++i) {
    const c = line.charCodeAt(i);
    if (c === 92 /* \ */) { ++i; continue; }
    if (c === 34 /* " */) return i + 1;
  }
  return -1;
}

/** Skip spaces and tabs from `i`. @returns the index of the first other char. */
function skipSpace(line: string, i: number): number {
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    ++i;
  }
  return i;
}

/**
 * Index just past a bare (unquoted) value: number, true/false/null, or any
 * run of characters that ends a JSON value. @returns -1 when there is none.
 */
function endOfBareValue(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 44 /* , */ || c === 125 /* } */ || c === 93 /* ] */ || c === 32 || c === 9 || c === 10 || c === 13) break;
    ++i;
  }
  return i === start ? -1 : i;
}

/**
 * Linear scan replacing the value of every `"<secret-key>": <value>` pair with
 * `"[redacted]"`. One pass, no regex: a line of `"\` repeats costs the same per
 * byte as prose. Quoted and bare values are both covered (`"private_key": 123`).
 */
function scrubPairs(line: string): string {
  let out = '';
  let copied = 0;      // index up to which `line` has been copied verbatim
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) !== 34 /* " */) { ++i; continue; }
    const keyEnd = endOfString(line, i);
    if (keyEnd < 0) break;
    let p = skipSpace(line, keyEnd);
    if (line.charCodeAt(p) !== 58 /* : */) { i = keyEnd; continue; }
    p = skipSpace(line, p + 1);
    const secret = isSecretKey(line.slice(i + 1, keyEnd - 1));
    const quoted = line.charCodeAt(p) === 34 /* " */;
    const valueEnd = quoted ? endOfString(line, p) : endOfBareValue(line, p);
    if (valueEnd < 0) {
      // A value truncated before its closing quote (a cut-off log line): redact
      // the rest of the line when the key is a secret, then stop.
      if (secret) return out + line.slice(copied, p) + '"' + REDACTED + '"';
      break;
    }
    if (secret) {
      out += line.slice(copied, p) + '"' + REDACTED + '"';
      copied = valueEnd;
    }
    i = valueEnd;
  }
  return copied === 0 ? line : out + line.slice(copied);
}
