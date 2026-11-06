/**
 * Credential redaction for server-side log and trace payloads.
 *
 * Names are matched EXACTLY after lowercasing and dropping `-`/`_`, never as a substring:
 * `tokens=5`, `tokenizer` and a `promptTokens` field are ordinary debug data and must survive.
 * The browser-side `src/utils/faro/redact.ts` deliberately over-redacts (substring match);
 * this one does not, because server logs are the debugging record.
 *
 * The next-axiom request-path patch (`patches/@civitai__next-axiom@0.17.0.patch`) inlines
 * CREDENTIAL_PARAM_NAMES; a parity test keeps the two in step.
 */

export const REDACTED_CREDENTIAL = '[redacted]';

/** Query-string parameter names whose values are credentials. */
export const CREDENTIAL_PARAM_NAMES: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'key',
  'secret',
  'clientsecret',
  'sig',
  'signature',
  'xamzsignature',
  'xamzcredential',
  'xgoogsignature',
  'password',
  'code',
]);

/** Object keys whose values are credentials. `code` is left out: it is usually an error code. */
export const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'xapikey',
  'secret',
  'clientsecret',
  'password',
  'webhooktoken',
]);

const normalize = (name: string) => name.toLowerCase().replace(/[-_]/g, '');

export const isCredentialParam = (name: string) => CREDENTIAL_PARAM_NAMES.has(normalize(name));
export const isCredentialField = (name: string) => CREDENTIAL_FIELD_NAMES.has(normalize(name));

// `name=value` after `?`, `&`, `#` or at the start (a bare query string such as OTel's `url.query`).
const QUERY_PARAM_RE = /(^|[?&#])([^=?&#\s"'<>]+)=([^&#\s"'<>]*)/g;
// 16+ chars so prose ("the bearer of bad news") is not mistaken for a credential.
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Blank credential query params and `Bearer` values in a string, leaving the rest intact. */
export function redactCredentialsInString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  if (out.includes('=')) {
    out = out.replace(QUERY_PARAM_RE, (match, sep: string, name: string, value: string) => {
      if (!value) return match;
      return isCredentialParam(safeDecode(name)) ? `${sep}${name}=${REDACTED_CREDENTIAL}` : match;
    });
  }
  if (/bearer/i.test(out)) out = out.replace(BEARER_RE, `$1 ${REDACTED_CREDENTIAL}`);
  return out;
}

const MAX_DEPTH = 20;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Return a copy of `value` with credential-named fields blanked and every string scrubbed by
 * `redactCredentialsInString`. Arrays and plain objects are walked; other objects (Error, Date,
 * class instances) pass through untouched, as does a reference already on the current path, so a
 * circular payload still reaches the caller's own serialization fallback. Never throws.
 */
export function redactCredentials<T>(value: T): T {
  try {
    return walk(value, 0, new WeakSet()) as T;
  } catch {
    return value;
  }
}

function walk(value: unknown, depth: number, path: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactCredentialsInString(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH || path.has(value)) return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;

  path.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => walk(v, depth + 1, path));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] =
        isCredentialField(k) && v != null && typeof v !== 'object'
          ? REDACTED_CREDENTIAL
          : walk(v, depth + 1, path);
    }
    out = obj;
  }
  path.delete(value);
  return out;
}
