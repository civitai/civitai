// App Block review boot-check outcomes, from the review-build watcher.
//
// One increment per boot check that settled a review preview (after its one retry on
// `unavailable`), labelled by the rollout mode it ran under and its result. `off` runs no check
// and counts nothing.
//
// 🔴 CARDINALITY: two closed labels, no slug, sha or user: 2 modes x 3 results = 6 series per
// pod, all seeded at 0 so "no failures" reads as a zero rather than as no data.
//
// HOW TO READ IT: a per-pod counter that resets on restart, like the neighbouring
// `civitai_app_block_builds_total`. Read it with a range function across pods.
import client, { type Counter, type Registry } from 'prom-client';

import {
  REVIEW_BOOT_CHECK_RESULTS,
  type ReviewBootCheckRecordedMode,
  type ReviewBootCheckResult,
} from '~/shared/utils/review-boot-check';

export const APP_BLOCK_REVIEW_BOOT_CHECKS_METRIC = 'civitai_app_block_review_boot_checks_total';

const MODES: readonly ReviewBootCheckRecordedMode[] = ['shadow', 'enforce'];

const HELP =
  'App Block review boot checks, one per review preview the check settled (after its retry). ' +
  'mode: shadow = recorded only, enforce = a failed check fails the preview. ' +
  'result: passed | failed (no BLOCK_READY in the host window) | unavailable (the checker could ' +
  'not run). Per-pod counter; read with range functions.';

function getOrCreateCounter(reg: Registry): Counter<string> {
  const existing = reg.getSingleMetric(APP_BLOCK_REVIEW_BOOT_CHECKS_METRIC) as
    | Counter<string>
    | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: APP_BLOCK_REVIEW_BOOT_CHECKS_METRIC,
    help: HELP,
    labelNames: ['mode', 'result'],
    registers: [reg],
  });
}

/** Get-or-create the counter and seed every series at 0. Idempotent; `/api/metrics` calls it. */
export function ensureRegisterAppBlockBootCheckMetrics(reg: Registry = client.register): {
  bootChecksTotal: Counter<string>;
} {
  const bootChecksTotal = getOrCreateCounter(reg);
  for (const mode of MODES)
    for (const result of REVIEW_BOOT_CHECK_RESULTS) bootChecksTotal.inc({ mode, result }, 0);
  return { bootChecksTotal };
}

/** Count one settled boot check. Never throws; a label outside its closed set is dropped. */
export function recordReviewBootCheck(
  mode: ReviewBootCheckRecordedMode,
  result: ReviewBootCheckResult
): void {
  try {
    if (!MODES.includes(mode)) return;
    if (!REVIEW_BOOT_CHECK_RESULTS.includes(result)) return;
    getOrCreateCounter(client.register).inc({ mode, result });
  } catch {
    // never throw from telemetry
  }
}
