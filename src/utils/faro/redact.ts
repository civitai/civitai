/**
 * Deterministic PII redaction for Faro RUM beacons.
 *
 * This is the PRIMARY privacy control for the frontend RUM pipeline (Faro Phase 1).
 * Session replay is OFF, but Faro still captures `page.url` (with its query string),
 * error messages, stack traces, breadcrumbs and event attributes. On this platform
 * that can leak OAuth `code`/reset/verify/unsubscribe tokens, signed download URLs,
 * payment-redirect params, emails and an NSFW browsing trail into Loki. Every one of
 * these functions is PURE and unit-tested (`__tests__/redact.test.ts`) and is wired
 * into the Faro `beforeSend` transport hook so it runs on every outgoing beacon.
 *
 * Bias: over-redaction is preferred over under-redaction. A false positive costs a
 * little debuggability; a false negative leaks a secret.
 */

export const REDACTED = 'REDACTED';
export const REDACTED_EMAIL = '[redacted-email]';
export const REDACTED_TOKEN = '[redacted-token]';

/**
 * Query/fragment param names (matched case-insensitively, as a SUBSTRING of the
 * param name) whose values must never leave the browser. Substring matching means
 * `id_token`, `refresh_token`, `apikey`, `csrf_token`, `sessionId`, `user_email`,
 * `x-amz-signature`, `verifyToken` etc. are all caught. Deliberately broad.
 */
export const SENSITIVE_PARAM_KEYS = [
  'token',
  'code',
  'key',
  'signature',
  'email',
  'secret',
  'session',
  'access_token',
  'otp',
  'verify',
  'password',
] as const;

/** True if a URL query/fragment param name is sensitive (case-insensitive substring). */
export function isSensitiveParam(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_PARAM_KEYS.some((k) => lower.includes(k));
}

// Matches an email address anywhere in a string.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Percent-encoded email (`@` → `%40`), as it appears in a URL/query string:
// `location.href` encodes `@`, so an email in a benign-named param (e.g. `?u=a%40b.com`)
// carries `%40` and would slip past EMAIL_RE.
const EMAIL_ENCODED_RE = /[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
// JWT (three base64url segments beginning with the `eyJ` header marker).
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
// Long opaque token-like strings (>=32 chars of base64url/hex alphabet). Requires at
// least one digit AND one letter so it doesn't nuke ordinary long words. Catches API
// keys, signatures, opaque session ids, etc. embedded in free text.
const LONG_TOKEN_RE = /(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g;
// A URL embedded in free text (message/stack). Stops at whitespace/quotes/brackets.
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>()\][{}]+/gi;

function redactParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const name of [...params.keys()]) {
    if (isSensitiveParam(name)) {
      params.set(name, REDACTED);
      changed = true;
    }
  }
  return changed;
}

/**
 * Redact sensitive query/fragment params from a URL, preserving everything else.
 * Handles absolute and relative URLs, and OAuth implicit-flow tokens carried in the
 * `#fragment`. Returns the input UNCHANGED when nothing sensitive is present (so a
 * clean URL is never needlessly reserialized). Never throws.
 */
export function redactUrl(input: string): string {
  if (!input || typeof input !== 'string') return input;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
    const base = 'http://redacted.invalid';
    const url = new URL(input, base);

    let changed = redactParams(url.searchParams);

    // OAuth implicit flow and some magic links carry params in the fragment,
    // e.g. `#access_token=...&state=...`. Treat a `key=value` fragment as a query.
    const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (rawHash.includes('=')) {
      const hashParams = new URLSearchParams(rawHash);
      if (redactParams(hashParams)) {
        url.hash = '#' + hashParams.toString();
        changed = true;
      }
    }

    if (!changed) return input;
    return hasScheme ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Malformed URL — fall back to a regex scrub of `sensitiveName=value` pairs.
    return input.replace(
      /([?&#][^=&#\s]*(?:token|code|key|signature|email|secret|session|otp|verify|password)[^=&#\s]*=)[^&#\s]*/gi,
      `$1${REDACTED}`
    );
  }
}

/**
 * Scrub free text (error messages, stack traces, breadcrumb strings): redact query
 * params in any embedded URL, then emails, then JWTs and long token-like strings.
 * URLs are handled FIRST so their sensitive params are redacted before the email/
 * token passes touch them. Never throws.
 */
export function redactText(input: string): string {
  if (!input || typeof input !== 'string') return input;
  try {
    return input
      .replace(URL_IN_TEXT_RE, (m) => redactUrl(m))
      .replace(EMAIL_RE, REDACTED_EMAIL)
      .replace(EMAIL_ENCODED_RE, REDACTED_EMAIL)
      .replace(JWT_RE, REDACTED_TOKEN)
      .replace(LONG_TOKEN_RE, REDACTED_TOKEN);
  } catch {
    return input;
  }
}

// Keys whose string values are treated as URLs (structure-preserving redactUrl first).
// `stringValue` is the OTLP attribute-value key — browser-trace span/event attributes
// (e.g. `http.url`) live at `resourceSpans[].scopeSpans[].spans[].attributes[].value
// .stringValue`, ~10 levels deep, so they MUST be url-aware and reachable (see MAX_DEPTH).
const URL_KEY_RE = /url|href|location|referrer|uri|stringValue/i;
// Deep enough to reach OTLP trace-span attribute values (~depth 10) plus headroom.
// A value past this cap is returned un-scrubbed, so it must exceed every real payload's
// PII-bearing nesting (trace attributes are the deepest known surface).
const MAX_DEPTH = 24;

/**
 * Recursively redact every string in an arbitrary value (Faro transport payload/meta).
 * URL-ish keys use the structure-preserving `redactUrl`; all other strings use
 * `redactText`. Returns a scrubbed CLONE — the input is not mutated. Bounded depth so
 * a pathological/cyclic payload can't blow the stack. Never throws (returns the input
 * as-is on error — the caller is a fire-and-forget beacon hook).
 */
export function deepRedact<T>(value: T, key = '', depth = 0): T {
  try {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === 'string') {
      const scrubbed = URL_KEY_RE.test(key) ? redactText(redactUrl(value)) : redactText(value);
      return scrubbed as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((v) => deepRedact(v, key, depth + 1)) as unknown as T;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = deepRedact(v, k, depth + 1);
      }
      return out as unknown as T;
    }
    return value;
  } catch {
    return value;
  }
}
