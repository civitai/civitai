// Orchestrator READ observability — the LEADING INDICATOR for an orchestrator park HOL-blocking the shared api pool.
//
// WHY this exists: the two orchestrator READ funnels (getWorkflow → orchestrator.statusUpdate poll, and
// queryWorkflows → queryGeneratedImages feed) had NO named span and NO metric. When a single getWorkflow parks
// on an orchestrator hang it pins an api-pool connection; because the pool is shared, enough parked polls
// head-of-line-block every cheap endpoint (a 7ms buzz.getBuzzAccount was observed at the 40s edge during
// parks). The getWorkflow read-backstop shipped in #2883 (ORCHESTRATOR_GET_TIMEOUT_MS = 20s) added a deadline
// so a park now 503s instead of hanging unbounded — but that fire was INVISIBLE: the ONLY signal a park/timeout
// happened was an indirect 503 rate blended in with every other cause. These two metrics turn "generation is
// mysteriously slow / 503ing" into a one-glance diagnosis: a spike in the read-duration tail by `op` + a
// climbing `orchestrator_read_timeouts_total{op=...}` points straight at the parked read funnel, and the healthy
// read-latency tail (the sub-cap buckets) tells us whether the 20s backstop is sized right.
//
// Registered on the shared `civitai_app_*` prom-client registry (`~/server/prom/client`, exposed by
// /api/metrics), same as session_resolution_* / trpc_procedure_duration. Cardinality-safe: only the bounded
// `op` / `outcome` labels, NEVER per-user or per-workflowId. This module owns the prom-client wiring; the
// callers in workflows.ts time only the orchestrator client network call and hand the raw timing here.
//
// 🔴 The `submit` op (added here) is a WRITE, not a read, and it is deliberately carried on this
// read-named metric rather than a sibling family. Rationale: `op` already enumerates the orchestrator
// client funnels this module wraps and the submit was simply the one call not wrapped, so one family
// keeps every orchestrator-client boundary comparable in a single query. The consequence to know
// before writing a query: an unfiltered `sum(rate(civitai_app_orchestrator_read_duration_seconds_...))`
// now BLENDS a write into a read total. Filter on `op` — always.
//
// WHY the submit op exists at all: `orchestrator.generateFromGraph` consumes ~9.5 server-s/s at peak
// (~12.6% of all dp-prod tRPC wall time) and 82–98% of that latency sits in one contiguous interval
// containing no spans and no metric at all. That interval is structurally three items — pure-CPU
// metadata assembly, refreshBlobUrlsInBody, and the submit POST — and the first two were excluded by
// measurement (blob refresh runs at 0.008 req/s against 4.44 submits/s). So the submit POST carries
// essentially the whole endpoint, and until this metric existed the ONLY bound on it was subtraction.
// The callee's own route metric cannot substitute: `POST /v2/consumer/workflows` serves App Blocks,
// external API consumers (which can pass an uncapped `wait=N`), orchestration-next and training too —
// its 202 population alone consumes 27.4 server-s/s against this procedure's total of 8.9, i.e. it is
// biased at least 3x high and is arithmetically incapable of sizing the caller's leg.
import { registerHistogram, registerCounterWithLabels } from '~/server/prom/client';

// The orchestrator client funnels in workflows.ts. `getWorkflow` = the single-workflow read behind the
// orchestrator.statusUpdate poll (fires continuously while a workflow runs — the most re-fetchable read we
// have); `queryWorkflows` = the multi-workflow list behind queryGeneratedImages / queue-status / admin;
// `submit` = the POST /v2/consumer/workflows WRITE behind generateFromGraph / whatIfFromGraph / the App
// Blocks and image-ingestion submits. `submit` times the WHOLE `submitWorkflowWithRetry` call (all attempts
// plus their backoff) because that is the interval the caller actually waits on and the only figure
// directly comparable against the procedure's own wall time. Per-attempt resolution is carried by the
// `gen:submit:orchestrator:attempt` spans and the retries counter below, not by this histogram.
export type OrchestratorReadOp = 'getWorkflow' | 'queryWorkflows' | 'submit';
// `ok` = a successful data result; `error` = any non-timeout failure (rejected non-timeout, or a !data result
// with a non-2xx status / status-less non-timeout error); `timeout` = the fired read-backstop AbortSignal.timeout
// (ORCHESTRATOR_GET_TIMEOUT_MS / ORCHESTRATOR_QUERY_TIMEOUT_MS), or on `submit` the whatIf/image-ingest
// per-attempt AbortSignal.timeout of the FINAL attempt.
export type OrchestratorReadOutcome = 'ok' | 'error' | 'timeout';

// Sub-ms (cache/warm-hit read) → the 20s backstop cap → a >20s park in +Inf. Deliberately carries an EXTRA 20
// bucket vs session_resolution_* so the p99 straddles the ORCHESTRATOR_*_TIMEOUT_MS cap cleanly: everything at
// or under the cap lands ≤20, anything that beat the deadline (or a mid-body abort just past it) lands in +Inf.
//
// The 45/60/90/120 buckets are for the `submit` op ONLY and are purely ADDITIVE — every pre-existing `le`
// remains, so no existing query or dashboard changes meaning. They exist because the generate submit is
// UNBOUNDED (no per-attempt timeout on the write path) and its observed ceiling recurs at ~95s (Loki max
// 94,800 ms), which is arithmetically consistent with 3 attempts x the Orleans 30s default response timeout
// plus 0.5s + 1.5s of backoff. Without a bucket above 30 the entire population this metric was added to see
// collapses into one +Inf bucket, and the histogram cannot distinguish a 32s submit from a 95s one.
const ORCHESTRATOR_READ_BUCKETS = [0.005, 0.05, 0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120] as const;

const durationHistogram = registerHistogram({
  name: 'orchestrator_read_duration_seconds',
  help:
    'Duration (seconds) of an orchestrator client call — the getWorkflow (statusUpdate poll) and ' +
    'queryWorkflows (queryGeneratedImages feed) READ funnels, and the submit WRITE (POST ' +
    '/v2/consumer/workflows, whole retry-wrapped call incl. backoff). Times ONLY the awaited orchestrator ' +
    'client call, not the surrounding handler. Labeled by op (getWorkflow|queryWorkflows|submit) + outcome ' +
    '(ok|error|timeout). ALWAYS filter on op: submit is a WRITE and is far slower than either read, so an ' +
    'unfiltered aggregate blends the two. The sub-20 buckets are the healthy read-latency tail (use to size ' +
    'the ORCHESTRATOR_*_TIMEOUT_MS backstop); the 45-120 buckets exist for the unbounded generate submit.',
  labelNames: ['op', 'outcome'] as const,
  buckets: [...ORCHESTRATOR_READ_BUCKETS],
});

const timeoutsCounter = registerCounterWithLabels({
  name: 'orchestrator_read_timeouts_total',
  help:
    'Count of orchestrator calls that hit a client-side deadline: the fired ' +
    'ORCHESTRATOR_GET_TIMEOUT_MS / ORCHESTRATOR_QUERY_TIMEOUT_MS read backstop (#2883), or on op=submit the ' +
    'whatIf / image-ingest per-attempt AbortSignal.timeout of the final attempt. Labeled by op ' +
    '(getWorkflow|queryWorkflows|submit). The leading indicator for an orchestrator park HOL-blocking the ' +
    'shared api pool — a nonzero rate means a funnel is parking and getting cut at its deadline. NOTE the ' +
    'generate (non-whatIf) submit path has NO per-attempt timeout, so a parked generate submit is invisible ' +
    'HERE and shows up only as a large duration observation on the histogram above.',
  labelNames: ['op'] as const,
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
    'submit contributes 2. Labeled by attempt (the 1-based index of the attempt that FAILED, so attempt=1 ' +
    'means the first try failed and a second is about to run) + outcome (network | a 5xx status | other). ' +
    'This settles whether the recurring ~95s generate-submit ceiling is a 3x retry multiplier or a single ' +
    'long attempt: before this counter the retry wrapper had NO observability at all (its onRetry hook had ' +
    'zero call sites and the attempts count was discarded), so a 3x amplification of every orchestrator ' +
    'stall was entirely unmeasured. Compare rate(...) against the submit rate on the histogram above.',
  labelNames: ['attempt', 'outcome'] as const,
});

/**
 * Record one orchestrator READ. Always observes the duration histogram (labeled by op + outcome); additionally
 * increments the timeout counter when the outcome is the fired read-backstop timeout. Cheap + TOTAL (never
 * throws) — it runs on the generation hot path (the statusUpdate poll + the image feed), so callers wire it in
 * directly around the client call. Wrapped so a metrics-layer hiccup can never take down a read.
 */
export function observeOrchestratorRead(
  op: OrchestratorReadOp,
  outcome: OrchestratorReadOutcome,
  durationSeconds: number
): void {
  try {
    durationHistogram.observe({ op, outcome }, durationSeconds);
    if (outcome === 'timeout') timeoutsCounter.inc({ op });
  } catch {
    // Observability must never break the read path. Swallow any prom-client error.
  }
}

/**
 * Normalize the failed attempt that triggered a retry into the bounded `outcome` enumeration. A retry only
 * fires when `retryable = !result.data && (status == null || status >= 500)`, so in practice this returns
 * `network` or a 5xx string; `other` exists so a future widening of the retry predicate cannot silently
 * introduce an unbounded label value.
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
 * (maxAttempts - 1) x |outcome|. Cheap + TOTAL (never throws) — it runs on the generation hot path.
 */
export function observeOrchestratorSubmitRetry(
  attempt: number,
  outcome: OrchestratorSubmitRetryOutcome
): void {
  try {
    submitRetriesCounter.inc({ attempt: String(attempt), outcome });
  } catch {
    // Observability must never break the submit path. Swallow any prom-client error.
  }
}
