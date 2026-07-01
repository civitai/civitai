// Prometheus metrics for the orchestrator-api service (mirrors apps/auth/src/lib/server/metrics.ts).
//
// Cardinality discipline: labels are bounded, low-cardinality enums ONLY. NEVER put userId / IP (or any
// unbounded value) in a label — that would blow up the time-series count and the scrape payload.
//
// All counters/histograms are registered at module load with their full label sets pre-declared, so they
// export a baseline before the first event (no "metric appears only after the first event" dashboard gaps).
//
// P0 NOTE: only the skeleton's own request/error counters are declared here. The generation_* continuity
// metrics (park duration, submit/whatIf outcomes) land with the moved surface in P1/P2 — this is the hook
// point for them.

import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

// Single default registry for the whole process. `register.metrics()` (the /metrics route) serializes
// everything registered here.
export const register = new Registry();

// Node process / heap / event-loop / GC metrics (process_*, nodejs_*). Cheap, scraped on demand.
collectDefaultMetrics({ register });

/** tRPC procedure calls, by procedure path + outcome (ok / error). Bounded: path is a finite router surface. */
export const trpcCallsTotal = new Counter({
  name: 'orchestrator_api_trpc_calls_total',
  help: 'tRPC procedure calls handled, labeled by procedure path and outcome.',
  labelNames: ['procedure', 'outcome'] as const,
  registers: [register],
});

/** tRPC procedure latency, by procedure path. Bounded label set. */
export const trpcDurationSeconds = new Histogram({
  name: 'orchestrator_api_trpc_duration_seconds',
  help: 'tRPC procedure handler duration in seconds, labeled by procedure path.',
  labelNames: ['procedure'] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/** Auth verification outcomes on the protected tRPC path (verified / unauthenticated / error). */
export const authOutcomesTotal = new Counter({
  name: 'orchestrator_api_auth_outcomes_total',
  help: 'Token verification outcomes on protected procedures, labeled by result.',
  labelNames: ['result'] as const,
  registers: [register],
});
