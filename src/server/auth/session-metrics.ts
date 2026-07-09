// Session-resolution observability — the LEADING INDICATOR for the app→hub hairpin SPOF class.
//
// WHY this lives in the calling app (not civitai-auth): a transient CF-edge blip stalled every authed request
// 40-90s while the hub itself was healthy — so the stall was INVISIBLE to the hub's own metrics. Only the app
// making the app→CF→hub identity/JWKS hops (and the sysRedis revocation read) can see this. These two metrics
// turn "authed traffic is mysteriously slow" into a one-glance diagnosis: a spike in the `identity`/`jwks` leg
// duration + a climbing `session_resolution_timeouts_total{leg=...}` points straight at the hop.
//
// Registered on the shared `civitai_app_*` prom-client registry (`~/server/prom/client`, exposed by
// /api/metrics), same as trpc_procedure_duration etc. Cardinality-safe: only bounded `leg` / `outcome` labels,
// NEVER per-user. The package emits the raw timings via injected callbacks (it stays infra-dep-free); this
// module owns the prom-client wiring.
import { registerHistogram, registerCounterWithLabels } from '~/server/prom/client';

// `identity` = token cookie path (getSessionUser); `identity-by-id` = API-key/OAuth/legacy by-userId read
// (getSessionUserById); `hub-write` = the invalidate/refresh/invalidateAll hub writes; `jwks` = ES256 verify
// key fetch; `revocation` = sysRedis TOKEN_STATE/ALL read.
export type SessionLeg = 'identity' | 'identity-by-id' | 'hub-write' | 'jwks' | 'revocation';
export type SessionLegOutcome = 'hit' | 'miss' | 'timeout' | 'error';

// Sub-ms (cache/crypto) → ~30s (a fully-stalled hairpin, the incident tail). Covers the whole span so a
// 40-90s stall lands in the +Inf bucket and the p99 is unmistakable.
const SESSION_RESOLUTION_BUCKETS = [0.005, 0.05, 0.5, 1, 2, 5, 10, 30] as const;

const durationHistogram = registerHistogram({
  name: 'session_resolution_duration_seconds',
  help:
    'Duration (seconds) of each session-resolution leg as seen by the CALLING app — the app→hub identity ' +
    'fetch (cookie + by-userId API-key/OAuth), the hub invalidate/refresh writes, the JWKS verify/refetch, ' +
    'and the sysRedis revocation read. The hub cannot observe these hops. Labeled by leg ' +
    '(identity|identity-by-id|hub-write|jwks|revocation) + outcome (hit|miss|timeout|error).',
  labelNames: ['leg', 'outcome'] as const,
  buckets: [...SESSION_RESOLUTION_BUCKETS],
});

const timeoutsCounter = registerCounterWithLabels({
  name: 'session_resolution_timeouts_total',
  help:
    'Count of session-resolution legs that hit their bounded-wait timeout (identity AbortSignal.timeout, ' +
    'JWKS timeoutDuration, or the sysRedis read deadline). Labeled by leg. The leading indicator for the ' +
    'app→hub hairpin SPOF — a nonzero rate means a leg is stalling.',
  labelNames: ['leg'] as const,
});

/**
 * Record one session-resolution leg. Always observes the duration histogram; additionally increments the
 * timeout counter when the outcome is a bounded-wait timeout. Cheap + total (never throws) — it runs on the
 * authed hot path, so callers wire it directly into the package's injected leg callbacks.
 */
export function observeSessionLeg(
  leg: SessionLeg,
  outcome: SessionLegOutcome,
  durationSeconds: number
): void {
  durationHistogram.observe({ leg, outcome }, durationSeconds);
  if (outcome === 'timeout') timeoutsCounter.inc({ leg });
}
