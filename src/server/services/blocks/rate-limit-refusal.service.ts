// App Blocks rate-limit refusals: the ONE recorder every server-side App Blocks limiter calls on
// its refusal branch. It moves `civitai_app_block_rate_limit_refusals_total{app_block_id, surface,
// bucket}` and writes one structured log line, so "which limit is this app hitting, and for whom"
// can be answered without the app's author reporting it.
//
// The set of call sites is pinned by
// `src/server/services/__tests__/no-unrecorded-block-rate-limit-refusal.test.ts`: a limiter call in
// App Blocks server code whose refusal does not reach this module fails that test.
//
// LOG VOLUME. A block in a hot loop can be refused hundreds of times a second, so the log line is
// throttled per (app, surface, bucket, viewer): the first refusal in a window is logged, the rest
// are counted and reported as `suppressed` on the next line written for that key. The METRIC is
// never throttled. The throttle is per process and bounded in memory: past
// `LOG_THROTTLE_MAX_KEYS` keys the map is cleared (the cost is one extra line per key, never an
// unbounded map).
import { logToAxiom } from '~/server/logging/client';
import { subjectUserIdOrNull } from '~/server/services/block-token-subject';
import {
  blockClaimsAppLabel,
  incAppBlockRateLimitRefusal,
  type AppBlockRateLimitBucket,
  type AppBlockRateLimitSurface,
  type AppBlockRefusalBucket,
} from '~/server/metrics/app-block-runtime.metrics';

export type AppBlockRateLimitRefusal = {
  /** The `app_block_id` label: `blockClaimsAppLabel(claims)` (`dev` for a dev token). */
  appBlockId: string;
  surface: AppBlockRateLimitSurface;
  bucket: AppBlockRefusalBucket;
  /** The seconds the refusal told the caller to wait, when it named one. */
  retryAfterSeconds?: number;
  /** The viewer the refusal applied to; null for an anonymous viewer. Log only, never a label. */
  userId: number | null;
  /** The HTTP status the caller received: 429, or 200 for a shed bridge poll/cancel. */
  status: number;
  /** Server-chosen name of the route or procedure that refused. Log only. */
  endpoint: string;
};

export const LOG_THROTTLE_WINDOW_MS = 60_000;
export const LOG_THROTTLE_MAX_KEYS = 10_000;

const lastLogged = new Map<string, { at: number; suppressed: number }>();

/** Test seam: forget every throttle window. */
export function resetRateLimitRefusalLogThrottleForTests(): void {
  lastLogged.clear();
}

/** Whether to write the log line for this key now, and how many lines were held back before it. */
function takeLogSlot(key: string, now: number): { log: boolean; suppressed: number } {
  const prev = lastLogged.get(key);
  if (prev && now - prev.at < LOG_THROTTLE_WINDOW_MS) {
    prev.suppressed += 1;
    return { log: false, suppressed: 0 };
  }
  if (!prev && lastLogged.size >= LOG_THROTTLE_MAX_KEYS) lastLogged.clear();
  lastLogged.set(key, { at: now, suppressed: 0 });
  return { log: true, suppressed: prev?.suppressed ?? 0 };
}

/**
 * Record one App Blocks rate-limit refusal: the per-app counter, and a throttled log line. TOTAL —
 * the refusal is already decided when this runs, and neither a metrics nor a logging fault may
 * turn it into a 500 (or, on the bridge's returning paths, into a throw).
 */
export function recordAppBlockRateLimitRefusal(refusal: AppBlockRateLimitRefusal): void {
  try {
    incAppBlockRateLimitRefusal(refusal.appBlockId, refusal.surface, refusal.bucket);
  } catch {
    /* instrument-only (also: a test that mocks the metrics module without this export) */
  }
  try {
    const key = `${refusal.appBlockId}|${refusal.surface}|${refusal.bucket}|${
      refusal.userId ?? 'anon'
    }`;
    const slot = takeLogSlot(key, Date.now());
    if (!slot.log) return;
    // `logToAxiom` never rejects (`no-logtoaxiom-catch`), so it is neither awaited nor caught.
    logToAxiom(
      {
        name: 'app-blocks-rate-limit-refusal',
        type: 'info',
        appBlockId: refusal.appBlockId,
        surface: refusal.surface,
        bucket: refusal.bucket,
        endpoint: refusal.endpoint,
        status: refusal.status,
        retryAfter: refusal.retryAfterSeconds ?? null,
        userId: refusal.userId,
        // Refusals for this same key since the last line, which the throttle did not log.
        suppressed: slot.suppressed,
      },
      'app-blocks'
    );
  } catch {
    /* instrument-only */
  }
}

/** The claims every bridge and REST limiter site holds. */
type RefusalClaims = { dev?: boolean; appBlockId: string; sub: string };

/** The viewer id of a verified `sub` claim, for the log line only (`subjectUserIdOrNull`). */
export function blockSubjectUserId(sub: string): number | null {
  return subjectUserIdOrNull(sub);
}

/**
 * A refusal at a limiter that holds verified block claims (a bridge procedure or a block REST
 * route). Derives the app label and viewer from the claims, so no call site computes them.
 */
export function recordBlockClaimsRateLimitRefusal(args: {
  claims: RefusalClaims;
  surface: 'rest' | 'bridge';
  bucket: AppBlockRefusalBucket;
  endpoint: string;
  retryAfterSeconds?: number;
  status?: number;
}): void {
  let appBlockId: string;
  try {
    appBlockId = blockClaimsAppLabel(args.claims);
  } catch {
    appBlockId = 'other';
  }
  recordAppBlockRateLimitRefusal({
    appBlockId,
    surface: args.surface,
    bucket: args.bucket,
    endpoint: args.endpoint,
    retryAfterSeconds: args.retryAfterSeconds,
    userId: blockSubjectUserId(args.claims.sub),
    status: args.status ?? 429,
  });
}

/**
 * A refusal at a `blocks.*` bridge procedure (or `authorizeBlockBridgeViewer`), on the per-app
 * counter `{surface="bridge"}`. The procedure is the log line's `endpoint`; it is not a label
 * (the procedure-only bridge counter this replaced is retired).
 *
 * `status`: 429 for a thrown TOO_MANY_REQUESTS (the default); 200 for the poll/cancel paths that
 * answer a shed request with a non-terminal snapshot.
 */
export function recordBridgeRateLimitRefusal(
  procedure: string,
  bucket: AppBlockRateLimitBucket,
  claims: RefusalClaims,
  retryAfterSeconds?: number,
  status = 429
): void {
  recordBlockClaimsRateLimitRefusal({
    claims,
    surface: 'bridge',
    bucket,
    endpoint: procedure,
    retryAfterSeconds,
    status,
  });
}
