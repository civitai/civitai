// Orchestrator SUBMIT observability — the timer on `POST /v2/consumer/workflows`, the one orchestrator
// client boundary that had no instrument of any kind.
//
// WHY this exists: `orchestrator.generateFromGraph` consumes ~9.5 server-s/s at the daily peak (~12.6% of
// all tRPC procedure wall time) and 82–98% of that latency sits in ONE contiguous interval containing no
// span and no metric. That interval is structurally three items — pure-CPU metadata assembly,
// `refreshBlobUrlsInBody`, and the submit POST — and the first two were excluded by measurement, so the
// submit POST carries essentially the whole endpoint. Until this metric existed the only bound on it was
// subtraction. Four instruments were blind to it by construction: there is no app-side timer on the submit
// leg, the call bypasses the edge (in-cluster service address), the api pool emits no client-kind spans so
// trace context never reached the callee, and continuous profiling has no per-request label.
//
// The callee's own route metric cannot substitute: `POST /v2/consumer/workflows` also serves App Blocks,
// external API consumers (which can pass an uncapped `wait=N`), the -next deployment and training. Its 202
// population alone consumes 27.4 server-s/s against this procedure's TOTAL of 8.9 — arithmetically
// impossible for a synchronous callee, i.e. biased at least 3x high.
//
// 🔴 WHY A SIBLING FAMILY, not a `submit` op on `orchestrator_read_duration_seconds`. The submit is a
// WRITE, it is unbounded (no per-attempt timeout on the generate path) and its observed ceiling recurs
// around 95 s, whereas both reads are hard-capped at 20 s by the #2883 backstop. Carrying it on the read
// family would have meant:
//   - prom-client applies ONE bucket array family-wide, so the >30 s boundaries the submit needs would also
//     be minted for `getWorkflow`/`queryWorkflows`, where they can never be anything but a copy of `le=30`;
//   - every honest read query would have to remember to filter `op!="submit"` forever — a footgun that has
//     to be documented rather than designed away;
//   - during a rollout, pods on the old and new bucket sets make `sum by (le)` non-monotonic, so quantiles
//     read as capped until the fleet is homogeneous.
// A separate family costs one more metric name and removes all three. Nothing about the read family
// changes, so no existing query, dashboard or alert can change meaning.
import { registerCounterWithLabels, registerHistogram } from '~/server/prom/client';

/**
 * WHICH submit population an observation belongs to. Bounded and closed — never derived from anything the
 * callee or a user controls.
 *
 * 🔴 This label is load-bearing, not decoration. `submitWorkflowWithRetry` is the single funnel for EVERY
 * orchestrator submit in the app: the generate leg, cost-estimate whatIfs, image ingestion (which calls the
 * wrapper directly), training, App Blocks, comics chat, prompt enhancement and product badges. Those
 * populations have wildly different latency distributions — whatIf is per-attempt-capped at 8 s, image
 * ingestion at its own cap, generate is uncapped — so an UNLABELLED submit histogram could not be compared
 * against `orchestrator.generateFromGraph`'s own wall time at all, which is the single comparison this
 * metric exists to support. Filter on `source` for any figure you intend to attribute.
 *
 * - `generate`    — the `generateFromGraph` submit (`orchestration-new.service.ts`), the population this PR
 *                   exists to size.
 * - `whatIf`      — any submit carrying `query.whatif === true`: a side-effect-free cost estimate, bounded
 *                   by `WHATIF_SUBMIT_ATTEMPT_TIMEOUT_MS` per attempt.
 * - `imageIngest` — the image-ingestion submit, which calls `submitWorkflowWithRetry` DIRECTLY rather than
 *                   through `submitWorkflow`.
 * - `other`       — every other submit funnel (training, App Blocks, comics chat, prompt enhancement,
 *                   product badge). The default, so a new caller can never silently land in `generate`.
 */
export type OrchestratorSubmitSource = 'generate' | 'whatIf' | 'imageIngest' | 'other';

/**
 * `ok` = the final attempt returned data. `timeout` = the final attempt's per-attempt
 * `AbortSignal.timeout` fired (whatIf / image ingest only — the generate path sets no per-attempt
 * deadline, so a parked generate submit is an `ok` or `error` with a large duration, never a `timeout`).
 * `error` = any other failure of the final attempt.
 */
export type OrchestratorSubmitOutcome = 'ok' | 'error' | 'timeout';

// 50 ms → 120 s. The low end resolves the healthy population (a warm submit is tens of ms); the top end
// exists because the generate submit has NO per-attempt timeout and its observed ceiling recurs at ~95 s
// (Loki max 94,800 ms), arithmetically consistent with 3 attempts x the Orleans 30 s default response
// timeout plus 0.5 s + 1.5 s of backoff. Without a boundary above 30 the entire population this metric was
// added to see would collapse into a single `+Inf` bucket, and a 32 s submit would be indistinguishable
// from a 95 s one — which is exactly the distinction that decides whether the fix is "cap the attempt" or
// "the callee hangs".
const ORCHESTRATOR_SUBMIT_BUCKETS = [
  0.05, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120,
] as const;

const submitDurationHistogram = registerHistogram({
  name: 'orchestrator_submit_duration_seconds',
  help:
    'Duration (seconds) of an orchestrator workflow submit (POST /v2/consumer/workflows) as the CALLER ' +
    'experiences it: the whole retry-wrapped call, all attempts plus their backoff. Recorded in ' +
    'submitWorkflowWithRetry, so it covers EVERY submit funnel in the app. Labeled by source ' +
    '(generate|whatIf|imageIngest|other) + outcome (ok|error|timeout). Filter on source before ' +
    'attributing a figure to a procedure — these populations have different caps and different latency ' +
    'distributions. Per-attempt resolution lives in the orchestrator:submit:attempt spans and in ' +
    'orchestrator_submit_retries_total, not in this histogram.',
  labelNames: ['source', 'outcome'] as const,
  buckets: [...ORCHESTRATOR_SUBMIT_BUCKETS],
});

const submitTimeoutsCounter = registerCounterWithLabels({
  name: 'orchestrator_submit_timeouts_total',
  help:
    'Count of orchestrator submits whose FINAL attempt was cut by its per-attempt AbortSignal.timeout. ' +
    'Labeled by source (generate|whatIf|imageIngest|other). NOTE the generate path sets NO per-attempt ' +
    'timeout, so source="generate" can never appear here by construction — a parked generate submit is ' +
    'visible only as a large observation on orchestrator_submit_duration_seconds. This is the leading ' +
    'indicator for the capped funnels (whatIf, image ingestion) parking against the orchestrator.',
  labelNames: ['source'] as const,
});

// The failure class of the ONE attempt that triggered a retry, bounded to a small enumeration so this label
// can never take a value the callee chooses freely. `network` = the attempt produced no HTTP status at all
// (a thrown fetch failure, or the resolve-with-no-response shape a fired AbortSignal.timeout produces);
// a bare 3-digit 5xx string = that upstream status; `other` = anything else the retry predicate let through.
export type OrchestratorSubmitRetryOutcome = 'network' | 'other' | `5${string}`;

const submitRetriesCounter = registerCounterWithLabels({
  name: 'orchestrator_submit_retries_total',
  help:
    'Count of orchestrator submit RETRIES actually fired by submitWorkflowWithRetry — one increment per ' +
    'backoff, so a submit that succeeded first try contributes nothing and a fully-exhausted 3-attempt ' +
    'submit contributes 2. Labeled by source (generate|whatIf|imageIngest|other) + attempt (the 1-based ' +
    'index of the attempt that FAILED, so attempt=1 means the first try failed and a second is about to ' +
    'run) + outcome (network | a 5xx status | other). This settles whether the recurring ~95s ' +
    'generate-submit ceiling is a 3x retry multiplier or a single long attempt: before this counter the ' +
    'retry wrapper had NO observability at all (its onRetry hook had zero call sites and the attempts ' +
    'count was discarded), so a 3x amplification of every orchestrator stall was entirely unmeasured. ' +
    'Compare rate(...) against the submit rate on orchestrator_submit_duration_seconds at the same source.',
  labelNames: ['source', 'attempt', 'outcome'] as const,
});

/**
 * Record ONE orchestrator submit — exactly one call per `submitWorkflowWithRetry` invocation, whichever
 * way it settled. Always observes the duration histogram; additionally increments the timeout counter when
 * the final attempt was cut by its own deadline. Cheap + TOTAL (never throws) — it runs on the generation
 * hot path, so a metrics-layer hiccup must not be able to take down a submit.
 */
export function observeOrchestratorSubmit(
  source: OrchestratorSubmitSource,
  outcome: OrchestratorSubmitOutcome,
  durationSeconds: number
): void {
  try {
    submitDurationHistogram.observe({ source, outcome }, durationSeconds);
    if (outcome === 'timeout') submitTimeoutsCounter.inc({ source });
  } catch {
    // Observability must never break the submit path. Swallow any prom-client error.
  }
}

/**
 * Normalize the failed attempt that triggered a retry into the bounded `outcome` enumeration. A retry only
 * fires when `retryable = !result.data && (status == null || status >= 500)`, so in practice this returns
 * `network` or a 5xx string; `other` exists so a future widening of the retry predicate cannot silently
 * introduce an unbounded label value.
 *
 * 🔴 The `>= 500 && <= 599` bound is what makes this label bounded, and BOTH ends are load-bearing, not
 * decoration: without the upper bound any integer the callee (or a proxy in front of it) puts on the wire
 * becomes a new series, so a misbehaving upstream could mint unbounded cardinality on a hot-path counter.
 * With it, `outcome` has at most 102 values. Both ends are pinned by test, not only by this comment.
 */
export function classifySubmitRetryOutcome(
  status: number | undefined
): OrchestratorSubmitRetryOutcome {
  if (status == null) return 'network';
  if (Number.isInteger(status) && status >= 500 && status <= 599)
    return String(status) as OrchestratorSubmitRetryOutcome;
  return 'other';
}

/**
 * Record ONE fired orchestrator submit retry. Called from `submitWorkflowWithRetry`'s `onRetry` hook — the
 * hook existed as a parameter with zero call sites, which is why a 3x retry multiplier on the single most
 * expensive tRPC procedure on the platform had never been counted. `attempt` is stringified because
 * prom-client label values are strings; it is bounded by `maxAttempts` (default 3), so the series count is
 * |source| x (maxAttempts - 1) x |outcome|. Cheap + TOTAL (never throws) — it runs on the generation hot
 * path.
 */
export function observeOrchestratorSubmitRetry(
  source: OrchestratorSubmitSource,
  attempt: number,
  outcome: OrchestratorSubmitRetryOutcome
): void {
  try {
    submitRetriesCounter.inc({ source, attempt: String(attempt), outcome });
  } catch {
    // Observability must never break the submit path. Swallow any prom-client error.
  }
}
