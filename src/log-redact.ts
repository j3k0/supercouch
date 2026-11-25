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
 * Redact a log line.
 *
 * When the line itself parses as JSON (a stringified command or error context),
 * re-stringify it with the deny-list replacer — secrets are redacted at any
 * depth. Otherwise fall back to a regex scrub of `"secret-key": "value"` pairs,
 * for message lines that embed a raw fragment of the input. Only pairs whose
 * key and value are directly quoted are touched: redaction cannot cross an
 * escaped string boundary, so a fragment of valid JSON is always scrubbed
 * exactly where its secrets sit.
 */
export function redactLine(line: string): string {
  if (line[0] === '{' || line[0] === '[') {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, createReplacer());
    } catch (e) { /* fall through to the regex scrub */ }
  }
  return line.replace(
    /("(?:[^"\\]|\\.)*?")(\s*:\s*)("(?:[^"\\]|\\.)*?")/g,
    (match, key: string, sep: string, value: string) =>
      isSecretKey(String(key).slice(1, -1)) ? `${key}${sep}"${REDACTED}"` : match,
  );
}
