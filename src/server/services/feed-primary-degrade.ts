import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import type { FeedAnswer } from '~/server/services/feed-shadow.service';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * Graceful degradation for the image feed's call to the feed service, behind the default-OFF
 * `feed-service-degrade` Flipt flag (unknown flag or uninitialised client reads as off, so the
 * flag needs no state to exist). Two parts, both off together:
 *
 * - A circuit breaker, the same state machine as withSignals (src/server/signals/wrapper.ts) and
 *   withMeili, reduced to one backend and no queue:
 *     CLOSED → (at least BREAKER.minCalls calls within BREAKER.windowMs, and more than
 *               BREAKER.failureRate of them failed) → OPEN
 *     OPEN → (BREAKER.cooldownMs elapsed) → HALF_OPEN, one trial call
 *     HALF_OPEN → trial succeeds → CLOSED;  trial fails → OPEN (new cooldown)
 *   A failure is a thrown fetch (timeout, refused) or a 5xx answer. A 4xx is the feed refusing a
 *   query, not the feed being down, and counts as a good call. A rate rather than a count, so one
 *   client repeating a query that always fails cannot open it for everyone else on the pod. While
 *   OPEN the call is not made at all.
 *
 * - A last-good page cache for ANONYMOUS FIRST PAGES only (no viewer, no cursor/offset/time cut),
 *   keyed by the exact feed query string, with one LRU per route: the website's default pages are
 *   the ones a feed outage costs most, and a burst of distinct anonymous REST queries must not
 *   evict them, so REST gets its own, smaller bound. It holds the feed's answer (ids, cursor, route), not
 *   rows: a stale page is hydrated from Postgres per request like a fresh one, so the request's
 *   own filters still apply to the rows. It is read only when the feed call fails or the breaker
 *   is open. A signed-in viewer never reads or writes it — their query carries their own
 *   exclusions, and a page cached for someone else must not be served to them.
 *
 * State lives on globalThis, as in withSignals: the server build can evaluate a module once per
 * runtime, and each copy would otherwise keep its own breaker and cache.
 */

export const FEED_BREAKER = {
  minCalls: 20,
  failureRate: 0.5,
  windowMs: 30_000,
  cooldownMs: 15_000,
} as const;
export const FEED_LAST_GOOD = {
  ttlMs: 10 * 60_000,
  maxEntries: { website: 500, rest: 100 },
} as const;
type LastGoodRoute = keyof typeof FEED_LAST_GOOD.maxEntries;
type LastGoodCache = Map<string, { answer: FeedAnswer; storedAt: number }>;

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
type DegradeState = {
  enabled: () => boolean;
  breaker: {
    state: BreakerState;
    // Unix ms of each call (and of each failed one) while CLOSED, oldest first, pruned to the window.
    calls: number[];
    failures: number[];
    cooldownUntil: number;
    // When the HALF_OPEN trial started, or 0. A trial older than the cooldown is treated as lost
    // so that a call that never reported back cannot hold the circuit open for good.
    trialStartedAt: number;
  };
  lastGood: Record<LastGoodRoute, LastGoodCache>;
};

declare global {
  // eslint-disable-next-line no-var
  var __civitaiFeedDegradeState: DegradeState | undefined;
}

function state(): DegradeState {
  return (globalThis.__civitaiFeedDegradeState ??= {
    enabled: createCachedFlagGate(readFliptSwitch(() => FLIPT_FEATURE_FLAGS.FEED_SERVICE_DEGRADE)),
    breaker: { state: 'CLOSED', calls: [], failures: [], cooldownUntil: 0, trialStartedAt: 0 },
    lastGood: { website: new Map(), rest: new Map() },
  });
}

const breakerTrips = registerCounterWithLabels({
  name: 'feed_primary_breaker_transitions_total',
  help: 'Feed-service circuit breaker state changes, by the state entered',
  labelNames: ['to'] as const,
});
const lastGoodCounter = registerCounterWithLabels({
  name: 'feed_primary_last_good_total',
  help: 'Last-good feed pages looked up after a feed failure, by result and the failure',
  labelNames: ['result', 'reason'] as const,
});

export const feedDegradeEnabled = () => state().enabled();

function transition(next: BreakerState, now: number) {
  const b = state().breaker;
  if (b.state === next) return;
  b.state = next;
  b.trialStartedAt = 0;
  if (next === 'OPEN') b.cooldownUntil = now + FEED_BREAKER.cooldownMs;
  if (next === 'CLOSED') {
    b.calls = [];
    b.failures = [];
    b.cooldownUntil = 0;
  }
  breakerTrips.inc({ to: next });
}

export type FeedAdmission = { admitted: false } | { admitted: true; isTrial: boolean };

/** Whether the feed may be called now. A trial admission must be reported with recordFeedCall. */
export function admitFeedCall(): FeedAdmission {
  const b = state().breaker;
  const now = Date.now();
  if (b.state === 'OPEN') {
    if (now < b.cooldownUntil) return { admitted: false };
    transition('HALF_OPEN', now);
  }
  if (b.state === 'HALF_OPEN') {
    if (b.trialStartedAt && now - b.trialStartedAt < FEED_BREAKER.cooldownMs)
      return { admitted: false };
    b.trialStartedAt = now;
    return { admitted: true, isTrial: true };
  }
  return { admitted: true, isTrial: false };
}

export function recordFeedCall(admission: FeedAdmission, failed: boolean) {
  if (!admission.admitted) return;
  const b = state().breaker;
  const now = Date.now();
  if (admission.isTrial) {
    transition(failed ? 'OPEN' : 'CLOSED', now);
    return;
  }
  if (b.state !== 'CLOSED') return;
  const cutoff = now - FEED_BREAKER.windowMs;
  pruneBefore(b.calls, cutoff);
  pruneBefore(b.failures, cutoff);
  b.calls.push(now);
  if (failed) b.failures.push(now);
  if (
    b.calls.length >= FEED_BREAKER.minCalls &&
    b.failures.length > b.calls.length * FEED_BREAKER.failureRate
  )
    transition('OPEN', now);
}

function pruneBefore(timestamps: number[], cutoff: number) {
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  if (i) timestamps.splice(0, i);
}

// Params that page or time-cut a feed; a query carrying any of them is not a first page.
const PAGING_PARAMS = ['cursor', 'offset', 'before'];

/**
 * The cache key for a request, or undefined when its page must not be cached: a signed-in viewer,
 * or anything past the first page.
 */
export function lastGoodKey(
  input: { currentUserId?: number | null },
  query: string
): string | undefined {
  if (input.currentUserId) return undefined;
  const params = new URLSearchParams(query);
  if (PAGING_PARAMS.some((p) => params.has(p)) || params.has('viewerId')) return undefined;
  return query;
}

export function writeLastGood(route: LastGoodRoute, key: string, answer: FeedAnswer) {
  const cache = state().lastGood[route];
  cache.delete(key);
  cache.set(key, { answer, storedAt: Date.now() });
  while (cache.size > FEED_LAST_GOOD.maxEntries[route]) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

/** The cached answer for `key` within its TTL; counts the lookup either way. */
export function readLastGood(
  route: LastGoodRoute,
  key: string | undefined,
  reason: string
): FeedAnswer | undefined {
  const cache = state().lastGood[route];
  const entry = key ? cache.get(key) : undefined;
  const fresh = entry && Date.now() - entry.storedAt <= FEED_LAST_GOOD.ttlMs ? entry : undefined;
  if (entry && !fresh && key) cache.delete(key);
  lastGoodCounter.inc({ result: fresh ? 'served' : key ? 'miss' : 'uncacheable', reason });
  return fresh?.answer;
}
