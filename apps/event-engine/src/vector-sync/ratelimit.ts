/**
 * Client side of the IETF RateLimit headers (draft-ietf-httpapi-ratelimit-headers) plus
 * Retry-After. Generic: no app imports, so it can move into a shared client.
 *
 *   RateLimit-Policy: "inflight-multimodalEmbedding";q=80, "buzz";q=1000;w=60
 *   RateLimit:        "inflight-multimodalEmbedding";r=3;t=0, "buzz";r=938;t=11
 *
 * q = quota, w = window (s), r = remaining, t = seconds until the quota resets.
 */

export type RateLimitParams = { q?: number; w?: number; r?: number; t?: number } & Record<
  string,
  number
>;

/**
 * Parses a structured-field list of `name;key=value` items. Names may be quoted strings or
 * tokens; parameters that are not numbers are dropped. A malformed item is skipped, not fatal.
 */
export function parseRateLimitHeader(
  header: string | null | undefined
): Map<string, RateLimitParams> {
  const out = new Map<string, RateLimitParams>();
  for (const item of splitList(header ?? '')) {
    const [rawName, ...params] = item.split(';');
    const name = rawName.trim().replace(/^"(.*)"$/, '$1');
    if (!name) continue;
    const values: RateLimitParams = {};
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq < 0) continue;
      const key = param.slice(0, eq).trim();
      const raw = param.slice(eq + 1).trim();
      // Structured-field integers and decimals only: Number('') is 0, and would read as r=0.
      if (key && /^-?\d+(\.\d+)?$/.test(raw)) values[key] = Number(raw);
    }
    out.set(name, values);
  }
  return out;
}

/** Splits on commas outside quoted strings. */
function splitList(header: string): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      items.push(current);
      current = '';
    } else current += ch;
  }
  items.push(current);
  return items.map((i) => i.trim()).filter(Boolean);
}

/**
 * Retry-After as milliseconds from `now`: delta-seconds or an HTTP-date, at most `maxMs` (past
 * 2^31 ms setTimeout fires at once). Undefined if absent or unparseable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number,
  maxMs = 60 * 60_000
): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(maxMs, Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.min(maxMs, Math.max(0, at - now));
}

export type Observation = {
  /** The policy's quota, when the response carried one. */
  quota?: number;
  remaining?: number;
  /** Every policy and its state, for logging. */
  policies: Map<string, RateLimitParams>;
  states: Map<string, RateLimitParams>;
};

/**
 * Tracks one rate-limit policy across responses and answers "may I send N now" and "when may I
 * send again". `remaining` is the server's `r`, decremented locally by what is sent until the
 * next response says otherwise; a server 429 is the backstop for any drift.
 */
export class RateLimiter {
  quota?: number;
  remaining?: number;
  /** No request before this time (ms epoch), from a 429's Retry-After. */
  holdUntil = 0;

  constructor(
    readonly policy: string,
    /** A Retry-After shorter than this is raised to it, so a 429 never becomes a tight loop. */
    readonly minRetryAfterMs = 250
  ) {}

  /** Reads the headers of any response, success or not. */
  observe(headers: { get(name: string): string | null }): Observation {
    const policies = parseRateLimitHeader(headers.get('ratelimit-policy'));
    const states = parseRateLimitHeader(headers.get('ratelimit'));
    const quota = policies.get(this.policy)?.q;
    const remaining = states.get(this.policy)?.r;
    if (quota !== undefined) this.quota = quota;
    if (remaining !== undefined) this.remaining = remaining;
    return { quota, remaining, policies, states };
  }

  /** Holds every request until `retryAfterMs` from `now`; returns the hold applied. */
  hold(retryAfterMs: number, now: number): number {
    const ms = Math.max(this.minRetryAfterMs, retryAfterMs);
    this.holdUntil = Math.max(this.holdUntil, now + ms);
    return ms;
  }

  /** Milliseconds to wait before any request, 0 if none. */
  waitMs(now: number): number {
    return Math.max(0, this.holdUntil - now);
  }

  /**
   * How many units may be sent now, at most `max`. Unknown remaining allows `max`. With nothing
   * of ours in flight a stale 0 would never refresh, so one unit is allowed and the server's
   * answer (or its 429) updates the picture.
   */
  allowance(max: number, nothingInFlight: boolean, now: number): number {
    if (this.waitMs(now) > 0) return 0;
    if (this.remaining === undefined) return max;
    if (this.remaining <= 0) return nothingInFlight ? 1 : 0;
    return Math.min(max, this.remaining);
  }

  /** Records units just sent against `remaining`. */
  reserve(units: number) {
    if (this.remaining !== undefined) this.remaining -= units;
  }
}
