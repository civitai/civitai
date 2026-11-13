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
import type { RefreshFailure } from '@civitai/auth';
import { registerCounterWithLabels, registerHistogram } from '~/server/prom/client';

// `identity` = token cookie path (getSessionUser); `identity-by-id` = API-key/OAuth by-userId read
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

// --- Revocation verdicts given without sysRedis ------------------------------------------------------------
// When the revocation read fails, the verdict comes from the markers this pod has already read
// (revocation-marker-cache.ts). `deny_cached` = a known marker revoked the session; `allow_unknown` = no
// known marker revoked it, so it was allowed as before the cache. A sustained `allow_unknown` rate is the
// volume of sessions whose revocation state nobody checked.
export type RevocationDegradedVerdict = 'deny_cached' | 'allow_unknown';

const revocationDegradedCounter = registerCounterWithLabels({
  name: 'session_revocation_degraded_total',
  help:
    'Session revocation checks answered without sysRedis because the read failed or timed out, by verdict: ' +
    'deny_cached (a revocation marker this pod had already read applied) or allow_unknown (no known marker ' +
    'applied, so the session was allowed).',
  labelNames: ['verdict'] as const,
});
for (const verdict of ['deny_cached', 'allow_unknown'] as const)
  revocationDegradedCounter.inc({ verdict }, 0);

export function observeRevocationDegraded(verdict: RevocationDegradedVerdict): void {
  revocationDegradedCounter.inc({ verdict });
}

// --- Session-state fan-out (refreshSession / invalidateSession) -------------------------------------------
// `updateSessionState` reads a user's whole token hash and writes one token-state field per token, so its
// cost scales with the account's session count. SLOWLOG can't see this below its 10ms threshold, which is
// where the persistent offenders sit — hence a duration histogram rather than a count.

export type SessionStateCaller =
  | 'ban'
  | 'strike'
  | 'subscription'
  | 'membership'
  | 'email-verification'
  | 'browsing-mode'
  | 'profile'
  | 'moderation'
  | 'admin'
  | 'job'
  | 'unspecified';

const sessionStateDuration = registerHistogram({
  name: 'session_state_update_duration_seconds',
  help:
    'Duration of updateSessionState (read the user token hash + mark every token). Labeled by caller and ' +
    'type (refresh|invalid). The read is a shared-store cost that scales with the account session count.',
  labelNames: ['caller', 'type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
});

// Bucket edges bracket the operational thresholds this path is held to; traffic in the upper buckets is
// out-of-band and worth investigating, not just large.
const sessionStateTokens = registerHistogram({
  name: 'session_state_tokens',
  help:
    'Number of tracked tokens touched by one updateSessionState call. The upper buckets are out-of-band ' +
    'and worth investigating.',
  labelNames: ['caller', 'type'] as const,
  buckets: [1, 10, 50, 100, 500, 1000, 4000, 10000],
});

// Per-chunk duration for the batched token-state write. The store's slowlog threshold is 10ms and a healthy
// chunk is sub-millisecond, so the slowlog can only catch a chunk that is catastrophically oversized — it
// cannot tell a well-sized chunk from a mildly bad one. This histogram is the finer instrument.
const sessionStateChunkDuration = registerHistogram({
  name: 'session_state_chunk_duration_seconds',
  help:
    'Duration of one chunk of the batched session-state write. A chunk is expected to be sub-millisecond; ' +
    'sustained traffic in the upper buckets means the chunk size is too large for this store.',
  labelNames: ['caller', 'type'] as const,
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.1],
});

export function observeSessionStateChunk(
  caller: SessionStateCaller,
  type: 'refresh' | 'invalid',
  durationSeconds: number
): void {
  sessionStateChunkDuration.observe({ caller, type }, durationSeconds);
}

export function observeSessionStateUpdate(
  caller: SessionStateCaller,
  type: 'refresh' | 'invalid',
  tokenCount: number,
  durationSeconds: number
): void {
  sessionStateDuration.observe({ caller, type }, durationSeconds);
  sessionStateTokens.observe({ caller, type }, tokenCount);
}

// --- Hub calls on the user's behalf ------------------------------------------------------------------------

const rollFailedCounter = registerCounterWithLabels({
  name: 'session_roll_failed_total',
  help:
    'Rolling session refreshes that did not return a fresh token: declined (the hub refused) or unreachable. ' +
    'The user keeps the current token, so nothing else shows these.',
  labelNames: ['reason'] as const,
});
for (const reason of ['declined', 'unreachable'] as const) rollFailedCounter.inc({ reason }, 0);

export function observeSessionRollFailed(reason: RefreshFailure): void {
  rollFailedCounter.inc({ reason });
}
