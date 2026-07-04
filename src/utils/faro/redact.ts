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
//
// ⚠️ COLLATERAL-DAMAGE HAZARD: this pattern ALSO matches legitimate STRUCTURAL identifiers
// that happen to be long hex/base64 — most importantly an OTLP `traceId` (32 hex). Rewriting
// one to `[redacted-token]` produces an invalid id and Alloy's faro.receiver rejects the whole
// beacon with HTTP 400 (prod incident). It is therefore applied ONLY in genuine free-text
// contexts (`redactText`: error messages, stack traces, breadcrumbs), NEVER on arbitrary
// structural leaf values (`redactValue`) and NEVER on `traceId`/`spanId`/`parentSpanId`
// (`deepRedact` skips those keys entirely).
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
 * Structural-leaf scrub for an arbitrary string VALUE (not known to be free text): redact
 * query params in any embedded URL, then emails, then JWTs. Deliberately does NOT apply the
 * bare "long token-like string" heuristic (`LONG_TOKEN_RE`) — that heuristic corrupts
 * legitimate long structural identifiers (OTLP trace/span ids, content hashes, cache keys)
 * and is reserved for genuine free text (see `redactText`). Never throws.
 *
 * This still catches every enumerated leak path that isn't message-embedded: OAuth `code`
 * and signed-URL signatures (URL query params → `redactUrl`), and emails (raw or `%40`).
 */
export function redactValue(input: string): string {
  if (!input || typeof input !== 'string') return input;
  try {
    return input
      .replace(URL_IN_TEXT_RE, (m) => redactUrl(m))
      .replace(EMAIL_RE, REDACTED_EMAIL)
      .replace(EMAIL_ENCODED_RE, REDACTED_EMAIL)
      .replace(JWT_RE, REDACTED_TOKEN);
  } catch {
    return input;
  }
}

/**
 * Scrub genuine FREE TEXT (error messages, stack traces, breadcrumb strings): everything
 * `redactValue` does, plus the bare "long token-like string" heuristic for opaque secrets
 * pasted into prose (API keys/signatures with no `eyJ` JWT marker and not in a URL param).
 * URLs are handled FIRST so their sensitive params are redacted before the email/token
 * passes touch them. Never throws.
 *
 * Use this ONLY where the string is known to be free text; on arbitrary structural leaves
 * use `redactValue` (which omits the collateral-damage-prone long-token pass).
 */
export function redactText(input: string): string {
  if (!input || typeof input !== 'string') return input;
  try {
    return redactValue(input).replace(LONG_TOKEN_RE, REDACTED_TOKEN);
  } catch {
    return input;
  }
}

// Keys whose string values are treated as URLs (structure-preserving redactUrl first).
// `stringValue` is the OTLP attribute-value key — browser-trace span/event attributes
// (e.g. `http.url`) live at `resourceSpans[].scopeSpans[].spans[].attributes[].value
// .stringValue`, ~10 levels deep, so they MUST be url-aware and reachable (see MAX_DEPTH).
const URL_KEY_RE = /url|href|location|referrer|uri|stringValue/i;
// STRUCTURAL OTLP identifier keys (camelCase Faro/OTLP-JSON + snake_case OTLP variants).
// Their values are trace/span ids that MUST be valid hex (traceId 32, spanId 16) or Alloy's
// faro.receiver rejects the whole beacon with HTTP 400. They carry no PII, so they are passed
// through byte-identical — never scrubbed — wherever they appear (span, span-event, span-link).
const STRUCTURAL_ID_KEY_RE = /^(?:trace_?id|span_?id|parent_?span_?id)$/i;
// Keys whose string values are genuine FREE TEXT (error/log messages, stack traces,
// breadcrumbs) — the only place the collateral-damage-prone long-token heuristic is applied.
const TEXT_KEY_RE = /^(?:message|value|reason|description|error|stack|stacktrace|stack_trace)$/i;
// Deep enough to reach OTLP trace-span attribute values (~depth 10) plus headroom.
// A value past this cap is returned un-scrubbed, so it must exceed every real payload's
// PII-bearing nesting (trace attributes are the deepest known surface).
const MAX_DEPTH = 24;

/**
 * Recursively redact every string in an arbitrary value (Faro transport payload/meta).
 * Per-string routing by KEY (deterministic, not value-shape heuristics):
 *   - structural OTLP id keys (traceId/spanId/parentSpanId, camel + snake) → passed through
 *     untouched (scrubbing them = invalid id = Alloy 400 drops the beacon);
 *   - URL-ish keys → structure-preserving `redactUrl` + full `redactText` (page.url is the
 *     top PII surface — tokens ride in path segments too, so it keeps the long-token pass);
 *   - free-text keys (message/stack/…) → full `redactText` (incl. the long-token heuristic);
 *   - every other string → `redactValue` (email/JWT/embedded-URL params only — NO bare
 *     long-token pass, which would corrupt long structural ids/hashes).
 * Returns a scrubbed CLONE — the input is not mutated. Bounded depth so a pathological/cyclic
 * payload can't blow the stack. Never throws (returns the input as-is on error — the caller is
 * a fire-and-forget beacon hook).
 */
export function deepRedact<T>(value: T, key = '', depth = 0): T {
  try {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === 'string') {
      // Structural OTLP ids (traceId/spanId/parentSpanId, camel + snake) pass through
      // untouched — scrubbing them yields an invalid id and Alloy 400s the whole beacon.
      if (STRUCTURAL_ID_KEY_RE.test(key)) return value;
      let scrubbed: string;
      if (URL_KEY_RE.test(key)) {
        // URL-ish value (page.url, http.url stringValue, href/location/referrer/uri):
        // structure-preserving param scrub, then the FULL free-text scrub incl. the
        // long-token pass. page.url is on every beacon and the highest-value PII surface —
        // reset/verify/unsubscribe tokens and bare opaque tokens can ride in PATH segments
        // (not just query params), so the long-token pass must cover it (restores #2929).
        // SAFE re: the Alloy 400 — structural ids (traceId/spanId/parentSpanId) are
        // keyed-skipped ABOVE this branch, and Alloy's faro.receiver does not format-validate
        // attribute/URL string values (only the structural ids), so this cannot recreate the
        // incident. A cosmetically-corrupted long path segment is an acceptable price for the
        // PII coverage.
        scrubbed = redactText(redactUrl(value));
      } else if (TEXT_KEY_RE.test(key)) {
        // Genuine free text (error/log messages, stack traces): full scrub incl. long-token.
        scrubbed = redactText(value);
      } else {
        // Arbitrary structural leaf: scrub PII (email/JWT/embedded-URL params) but never the
        // bare long-token heuristic that corrupts ids/hashes.
        scrubbed = redactValue(value);
      }
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
