// Fleet-wide App Block build outcomes, from the build callbacks.
//
// One increment per APPLIED build callback outcome (after signature, flag, body and
// timestamp checks, and after the stale-run guard: a superseded run's late failure is not
// counted), plus one per failed or timed-out deploy of an image that built. A repeated
// delivery of the same FAILURE callback counts again: the build service re-sends only when
// an earlier delivery got no 2xx, so that is rare, but it is not deduplicated here. A
// repeated SUCCESS callback is not counted twice within the replay-guard window (it stops
// at the apply replay guard before the increment).
//
// 🔴 CARDINALITY: four labels, each a closed set validated in code, with NO slug, sha,
// run id or user. Correlation is "many failures with the same step and class", not
// per-app; per-app attribution is in the build attempt rows. The reachable label sets
// are enumerated in `REACHABLE_SERIES` and seeded at 0: 2 modes x 10 = 20 series per pod.
//
// HOW TO READ IT: prom-client counters live in the pod heap and reset on restart. Count
// with `sum(increase(civitai_app_block_builds_total{...}[1h]))`, never a bare `sum()`.
//
// Same registry rules as the neighbouring modules: get-or-create against the DEFAULT
// registry (the one `/api/metrics` serves), and import only from the request graph.
import client, { type Counter, type Registry } from 'prom-client';

import { deriveFailureClass } from '~/server/services/blocks/build-signals';
import {
  BUILD_FAILED_STEPS,
  BUILD_FAILURE_CLASSES,
  type BuildFailedStep,
  type BuildFailureClassSignal,
} from '~/shared/constants/app-block-build.constants';

export const APP_BLOCK_BUILDS_METRIC = 'civitai_app_block_builds_total';

export type AppBlockBuildMode = 'build' | 'review';
export type AppBlockBuildOutcome = 'succeeded' | 'failed';
/**
 * `apply` = the civitai-side deploy of a built image. `unreported` = a failed callback
 * from a pipeline that sent no `failedStep`.
 */
export type AppBlockBuildStepLabel = BuildFailedStep | 'apply' | 'unreported';
/** `none` on a success. */
export type AppBlockBuildClassLabel = BuildFailureClassSignal | 'none';

const MODES: readonly AppBlockBuildMode[] = ['build', 'review'];
const STEP_LABELS: ReadonlySet<string> = new Set([...BUILD_FAILED_STEPS, 'apply', 'unreported']);
const CLASS_LABELS: ReadonlySet<string> = new Set([...BUILD_FAILURE_CLASSES, 'none']);

type Series = {
  outcome: AppBlockBuildOutcome;
  failed_step: AppBlockBuildStepLabel;
  failure_class: AppBlockBuildClassLabel;
};

/** Every (outcome, step, class) one mode can emit, derived from the class table itself. */
export const REACHABLE_SERIES: readonly Series[] = [
  { outcome: 'succeeded', failed_step: 'none', failure_class: 'none' },
  ...BUILD_FAILED_STEPS.flatMap((step) => {
    const classes = new Set([deriveFailureClass(step), deriveFailureClass(step, 'TaskRunTimeout')]);
    return [...classes].map((cls) => ({
      outcome: 'failed' as const,
      failed_step: step,
      failure_class: cls,
    }));
  }),
  { outcome: 'failed', failed_step: 'apply', failure_class: deriveFailureClass('apply') },
  { outcome: 'failed', failed_step: 'unreported', failure_class: 'unknown' },
];

const HELP =
  'App Block build outcomes, one per accepted build callback plus one per failed deploy of a ' +
  'built image. mode: build = production lane, review = moderator review sandbox. ' +
  'outcome: succeeded | failed. failed_step: the pipeline step that failed (clone, validate, ' +
  'build, scan, push), none when no step failed, apply = the image built but the deploy did ' +
  'not finish, unreported = the pipeline sent no step. failure_class: author | platform | ' +
  'transient | unknown, derived from the step (none on success). No per-app label: use the ' +
  'build attempt rows for that. Per-pod counter; read with range functions.';

function getOrCreateCounter(reg: Registry): Counter<string> {
  const existing = reg.getSingleMetric(APP_BLOCK_BUILDS_METRIC) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: APP_BLOCK_BUILDS_METRIC,
    help: HELP,
    labelNames: ['mode', 'outcome', 'failed_step', 'failure_class'],
    registers: [reg],
  });
}

/**
 * Get-or-create the counter and materialise every reachable series at 0, so an alert's
 * "no failures" reads as a zero rather than as `no data`. Idempotent; `/api/metrics` calls
 * it once, at module load.
 */
export function ensureRegisterAppBlockBuildMetrics(reg: Registry = client.register): {
  appBlockBuildsTotal: Counter<string>;
} {
  const appBlockBuildsTotal = getOrCreateCounter(reg);
  for (const mode of MODES)
    for (const series of REACHABLE_SERIES) appBlockBuildsTotal.inc({ mode, ...series }, 0);
  return { appBlockBuildsTotal };
}

/**
 * Count one build outcome. Never throws: telemetry must not break a build callback.
 * A label value outside its closed set is dropped rather than emitted, so the series
 * count cannot grow past the seeded set.
 */
export function recordAppBlockBuildOutcome(o: {
  mode: AppBlockBuildMode;
  outcome: AppBlockBuildOutcome;
  failedStep: AppBlockBuildStepLabel;
  failureClass: AppBlockBuildClassLabel;
}): void {
  try {
    if (!MODES.includes(o.mode)) return;
    if (o.outcome !== 'succeeded' && o.outcome !== 'failed') return;
    if (!STEP_LABELS.has(o.failedStep) || !CLASS_LABELS.has(o.failureClass)) return;
    getOrCreateCounter(client.register).inc({
      mode: o.mode,
      outcome: o.outcome,
      failed_step: o.failedStep,
      failure_class: o.failureClass,
    });
  } catch {
    // never throw from telemetry
  }
}
