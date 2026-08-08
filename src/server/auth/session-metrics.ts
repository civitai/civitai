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

// --- Session-token MINT rate ------------------------------------------------------------------------------
// The store records only LAST TOUCH: `trackToken` writes the field value AND re-arms the field TTL on every
// call, including the rolling refresh, so neither the value nor `30d - HTTL` is a creation time. No query
// against session:user-tokens2 can recover a mint rate for any account — this counter is the only instrument
// that can. See _local/docs/plans/session-system-audit-2026-08-08.md.

export type LegacyUpgradeOutcome = 'minted' | 'no-token' | 'failed';

const legacyUpgradeCounter = registerCounterWithLabels({
  name: 'session_legacy_upgrade_total',
  help:
    'Legacy next-auth cookie → civ-token upgrade-on-read attempts. Each `minted` is a NEW jti tracked in ' +
    'session:user-tokens2, so a sustained rate means clients are re-minting rather than persisting the ' +
    'returned cookie. Bounded outcome label only — per-user attribution goes to the Axiom event.',
  labelNames: ['outcome'] as const,
});

export function observeLegacyUpgrade(outcome: LegacyUpgradeOutcome): void {
  legacyUpgradeCounter.inc({ outcome });
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

// Bucket edges bracket the operational thresholds: 500 is the mint ceiling, 4000 the Lua unpack ceiling
// above which the write silently lands nothing.
const sessionStateTokens = registerHistogram({
  name: 'session_state_tokens',
  help:
    'Number of tracked tokens touched by one updateSessionState call. Above ~4000 the multi-field write ' +
    'exceeds the Lua unpack limit and lands NOTHING while reporting success, so the upper buckets are a ' +
    'revocation-failure indicator, not just a size one.',
  labelNames: ['caller', 'type'] as const,
  buckets: [1, 10, 50, 100, 500, 1000, 4000, 10000],
});

export function observeSessionStateUpdate(
  caller: SessionStateCaller,
  type: 'refresh' | 'invalid',
  tokenCount: number,
  durationSeconds: number
): void {
  sessionStateDuration.observe({ caller, type }, durationSeconds);
  sessionStateTokens.observe({ caller, type }, tokenCount);
}
