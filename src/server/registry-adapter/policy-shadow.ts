/**
 * Shadow mode for the content-policy service (apps/content-policy-go): each subscription is still
 * decided exactly as before (`audience.ts`, `request-origin.ts`), and the service is asked the same
 * question beside it, so the two can be compared in production before any caller switches.
 *
 * Off unless `REGISTRY_ADAPTER_POLICY_URL` is set ({@link policyShadowFromEnv}). When on:
 *   - after a subscription's principal is decided, {@link PolicyShadow} sends the service the
 *     viewer (the token's user id, or none) and the region values this source judged (the same
 *     headers, with `meta` applied as `regionHeaders` applies it), with a short timeout;
 *   - it compares the service's ratings, unknown-rating answer and region hold with what this source
 *     decided, and counts the outcome in `registry_adapter_policy_shadow_total{result}`:
 *     `agree`, `disagree`, `error` (the service answered an error, its SFW fallback, or a body that
 *     is not a decision) or `timeout`;
 *   - on a disagreement it logs one line naming the first field that differs and both values, and
 *     nothing that identifies the viewer (no user id, address or token).
 *
 * 🔴 It never changes the live decision: the call is not awaited by the subscription, it is handed
 * copies of values already decided, and every failure inside it is caught here. The subscription
 * has started streaming whether the service answers, errs or never answers.
 */
import { createServer, type Server } from 'node:http';
import { Counter, Registry } from 'prom-client';
import type { Principal } from '~/server/registry-adapter/auth';
import { audienceAdmits } from '~/server/registry-adapter/audience';
import type { RequestOrigin } from '~/server/registry-adapter/request-origin';
import { regionHeaders } from '~/server/registry-adapter/request-origin';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

/** The ratings the service answers for, in its order (apps/content-policy-go policy.Ratings). */
export const POLICY_RATINGS = ['g', 'pg', 'pg13', 'r', 'x', 'xxx'] as const;

/** The service's caller context for a subscription. */
export const POLICY_CONTEXT = 'registry-subscription';

export const SHADOW_RESULTS = ['agree', 'disagree', 'error', 'timeout'] as const;
export type ShadowResult = (typeof SHADOW_RESULTS)[number];

export const DEFAULT_POLICY_TIMEOUT_MS = 250;
export const DEFAULT_METRICS_PORT = 7132;

/** What this source decided for a subscription, in the service's terms. */
export type OurDecision = {
  ratings: string[];
  unknownRating: boolean;
  /** Whether the region held the request to SFW (`request-origin.ts`). */
  held: boolean;
};

/** The body of the service's `POST /v1/decide` for a subscription. */
export type PolicyRequest = {
  context: typeof POLICY_CONTEXT;
  userId?: number;
  country?: string;
  region?: string;
  isUk?: string;
};

/** The part of the service's answer the shadow compares. */
type PolicyAnswer = {
  ratings: string[];
  unknownRating: boolean;
  regionHold: string;
  fallback?: boolean;
};

/**
 * The user id in a principal's subject (`user:<id>/client:<id>`, `auth.live.ts`), undefined for
 * anonymous, null when the subject does not have that form.
 */
export function userIdOfSubject(subject: string | null): number | undefined | null {
  if (subject === null) return undefined;
  const m = /^user:(\d{1,10})\//.exec(subject);
  return m ? Number(m[1]) : null;
}

/** What the subscription was decided: its audience's ratings and its region hold. */
export function ourDecision(principal: Principal, held: boolean): OurDecision {
  return {
    ratings: POLICY_RATINGS.filter((r) => audienceAdmits(principal.audience, r)),
    unknownRating: audienceAdmits(principal.audience, null),
    held,
  };
}

/**
 * A header value as `getRegion` would read it: as is, a repeated header (an array) joined with
 * commas, as JavaScript turns the array into a string, and absent when there is none.
 */
const headerValue = (v: string | string[] | undefined) =>
  v === undefined ? undefined : Array.isArray(v) ? v.join(',') : v;

/** The service request for a subscription, or null when its subject names no user id. */
export function policyRequest(origin: RequestOrigin, principal: Principal): PolicyRequest | null {
  const userId = userIdOfSubject(principal.subject);
  if (userId === null) return null;
  const { headers } = regionHeaders(origin);
  const body: PolicyRequest = { context: POLICY_CONTEXT };
  if (userId !== undefined) body.userId = userId;
  const country = headerValue(headers['cf-ipcountry']);
  const region = headerValue(headers['cf-region-code']);
  const isUk = headerValue(headers['x-isuk']);
  if (country !== undefined) body.country = country;
  if (region !== undefined) body.region = region;
  if (isUk !== undefined) body.isUk = isUk;
  return body;
}

/** The first field where the two decisions differ, or null when they agree. */
export function compareDecisions(
  ours: OurDecision,
  service: PolicyAnswer
): { field: string; ours: string; service: string } | null {
  const ratings = (rs: readonly string[]) => rs.join(',') || 'none';
  if (ratings(ours.ratings) !== ratings(service.ratings))
    return { field: 'ratings', ours: ratings(ours.ratings), service: ratings(service.ratings) };
  if (ours.unknownRating !== service.unknownRating)
    return {
      field: 'unknownRating',
      ours: String(ours.unknownRating),
      service: String(service.unknownRating),
    };
  const serviceHeld = service.regionHold !== 'none';
  if (ours.held !== serviceHeld)
    return {
      field: 'regionHold',
      ours: ours.held ? 'held' : 'none',
      service: service.regionHold,
    };
  return null;
}

const isAnswer = (v: unknown): v is PolicyAnswer => {
  const a = v as PolicyAnswer;
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray(a.ratings) &&
    a.ratings.every((r) => typeof r === 'string') &&
    typeof a.unknownRating === 'boolean' &&
    typeof a.regionHold === 'string'
  );
};

/** One subscription's shadow comparison. Resolves with its result; never rejects. */
export type PolicyShadow = (s: {
  origin: RequestOrigin;
  principal: Principal;
  held: boolean;
}) => Promise<ShadowResult>;

/** The counter, on its own registry: the adapter has no other metrics. */
export function createShadowMetrics(registry = new Registry()) {
  const counter = new Counter({
    name: 'registry_adapter_policy_shadow_total',
    help: 'Subscriptions compared with the content-policy service, by result: agree, disagree, error (an error answer, its SFW fallback, or no decision in the body), timeout.',
    labelNames: ['result'],
    registers: [registry],
  });
  // Every result from zero, so a rate that never moved reads 0 rather than an absent series.
  for (const r of SHADOW_RESULTS) counter.inc({ result: r }, 0);
  return { registry, counter };
}

export function createPolicyShadow(opts: {
  /** The service's base URL; `/v1/decide` is resolved against it. */
  url: string;
  timeoutMs?: number;
  counter: Counter<'result'>;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}): PolicyShadow {
  const endpoint = new URL('/v1/decide', opts.url).toString();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const count = (result: ShadowResult) => {
    opts.counter.inc({ result });
    return result;
  };
  return async ({ origin, principal, held }) => {
    try {
      const ours = ourDecision(principal, held);
      const body = policyRequest(origin, principal);
      if (!body) return count('error');
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // The repo's outbound deadline (`outbound-fetch-timeouts-off` can drop it; the comparison is
        // never awaited by the subscription, so even without one it cannot hold a stream).
        signal: fetchTimeoutSignal(timeoutMs),
      });
      const answer: unknown = await res.json();
      if (!res.ok || !isAnswer(answer) || answer.fallback) return count('error');
      const diff = compareDecisions(ours, answer);
      if (!diff) return count('agree');
      log(
        `registry-adapter: policy shadow disagree field=${diff.field} ours=${diff.ours} ` +
          `service=${diff.service} context=${POLICY_CONTEXT}`
      );
      return count('disagree');
    } catch (err) {
      return count(
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timeout'
          : 'error'
      );
    }
  };
}

/**
 * Runs `shadow` for a subscription without waiting for it and without letting anything it does
 * reach the caller: the one way the bindings call it.
 */
export function runShadow(shadow: PolicyShadow | undefined, s: Parameters<PolicyShadow>[0]): void {
  if (!shadow) return;
  try {
    void shadow(s).catch(() => undefined);
  } catch {
    // A shadow that throws before returning its promise still leaves the subscription alone.
  }
}

/**
 * The shadow from the environment: null (off) unless REGISTRY_ADAPTER_POLICY_URL is set.
 *   REGISTRY_ADAPTER_POLICY_URL         the service's base URL (http or https)
 *   REGISTRY_ADAPTER_POLICY_TIMEOUT_MS  how long one comparison waits (default 250)
 *   REGISTRY_ADAPTER_METRICS_PORT       where `/metrics` is served while the shadow is on
 *                                       (default 7132)
 */
export function policyShadowFromEnv(env: Record<string, string | undefined>): {
  url: string;
  timeoutMs: number;
  metricsPort: number;
} | null {
  const url = env.REGISTRY_ADAPTER_POLICY_URL;
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('REGISTRY_ADAPTER_POLICY_URL is not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('REGISTRY_ADAPTER_POLICY_URL must be http or https');
  const positive = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  return {
    url,
    timeoutMs: positive('REGISTRY_ADAPTER_POLICY_TIMEOUT_MS', DEFAULT_POLICY_TIMEOUT_MS),
    metricsPort: positive('REGISTRY_ADAPTER_METRICS_PORT', DEFAULT_METRICS_PORT),
  };
}

/** A server answering `GET /metrics` from `registry`, and 404 for anything else. */
export function createMetricsServer(registry: Registry): Server {
  return createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (text) => res.writeHead(200, { 'content-type': registry.contentType }).end(text),
      () => res.writeHead(500).end()
    );
  });
}
