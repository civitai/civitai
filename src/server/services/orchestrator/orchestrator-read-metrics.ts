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
import { registerHistogram, registerCounterWithLabels } from '~/server/prom/client';

// The two orchestrator READ funnels in workflows.ts. `getWorkflow` = the single-workflow read behind the
// orchestrator.statusUpdate poll (fires continuously while a workflow runs — the most re-fetchable read we
// have); `queryWorkflows` = the multi-workflow list behind queryGeneratedImages / queue-status / admin.
export type OrchestratorReadOp = 'getWorkflow' | 'queryWorkflows';
// `ok` = a successful data result; `error` = any non-timeout failure (rejected non-timeout, or a !data result
// with a non-2xx status / status-less non-timeout error); `timeout` = the fired read-backstop AbortSignal.timeout
// (ORCHESTRATOR_GET_TIMEOUT_MS / ORCHESTRATOR_QUERY_TIMEOUT_MS).
export type OrchestratorReadOutcome = 'ok' | 'error' | 'timeout';

// Sub-ms (cache/warm-hit read) → the 20s backstop cap → a >20s park in +Inf. Deliberately carries an EXTRA 20
// bucket vs session_resolution_* so the p99 straddles the ORCHESTRATOR_*_TIMEOUT_MS cap cleanly: everything at
// or under the cap lands ≤20, anything that beat the deadline (or a mid-body abort just past it) lands in +Inf.
const ORCHESTRATOR_READ_BUCKETS = [0.005, 0.05, 0.5, 1, 2, 5, 10, 20, 30] as const;

const durationHistogram = registerHistogram({
  name: 'orchestrator_read_duration_seconds',
  help:
    'Duration (seconds) of the orchestrator client READ network call — the getWorkflow (statusUpdate poll) ' +
    'and queryWorkflows (queryGeneratedImages feed) funnels. Times ONLY the awaited orchestrator client call, ' +
    'not the surrounding handler. Labeled by op (getWorkflow|queryWorkflows) + outcome (ok|error|timeout). ' +
    'The sub-20 buckets are the healthy read-latency tail (use to size the ORCHESTRATOR_*_TIMEOUT_MS backstop); ' +
    '+Inf is a park that beat the 20s cap.',
  labelNames: ['op', 'outcome'] as const,
  buckets: [...ORCHESTRATOR_READ_BUCKETS],
});

const timeoutsCounter = registerCounterWithLabels({
  name: 'orchestrator_read_timeouts_total',
  help:
    'Count of orchestrator READ calls that hit their read-backstop deadline (the fired ' +
    'ORCHESTRATOR_GET_TIMEOUT_MS / ORCHESTRATOR_QUERY_TIMEOUT_MS AbortSignal.timeout, #2883). Labeled by op ' +
    '(getWorkflow|queryWorkflows). The leading indicator for an orchestrator park HOL-blocking the shared api ' +
    'pool — a nonzero rate means a read funnel is parking and getting cut at the backstop.',
  labelNames: ['op'] as const,
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
