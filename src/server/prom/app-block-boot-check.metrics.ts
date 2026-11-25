// App Block review boot-check outcomes, from the review-build watcher.
//
// One increment per boot check that settled a review preview (after its one retry on
// `unavailable`), labelled by the rollout mode it ran under, its result, and for `unavailable`
// why. `off` runs no check and counts nothing.
//
// 🔴 CARDINALITY: closed labels only, no slug, sha or user. Every reachable series is seeded at 0
// so 'no failures' reads as zero, not no data. `reason="contract"` (the checker refused the
// request with a 4xx) is a bug in this client or the checker, never an outage.
//
// HOW TO READ IT: a per-pod counter that resets on restart, like the neighbouring
// `civitai_app_block_builds_total`. Read it with a range function across pods.
import client, { type Counter, type Registry } from 'prom-client';

import type {
  ReviewBootCheckRecordedMode,
  ReviewBootCheckResult,
} from '~/shared/utils/review-boot-check';

export const APP_BLOCK_REVIEW_BOOT_CHECKS_METRIC = 'civitai_app_block_review_boot_checks_total';

const MODES: readonly ReviewBootCheckRecordedMode[] = ['shadow', 'enforce'];
export const BOOT_CHECK_UNAVAILABLE_REASONS = [
  'unconfigured',
  'network',
  'server',
  'contract',
  'body',
  'no-target',
  'crash',
] as const;
export type BootCheckReasonLabel = (typeof BOOT_CHECK_UNAVAILABLE_REASONS)[number] | 'none';

/** Every (result, reason) pair the watcher can emit. */
const SERIES: readonly { result: ReviewBootCheckResult; reason: BootCheckReasonLabel }[] = [
  { result: 'passed', reason: 'none' },
  { result: 'failed', reason: 'none' },
  ...BOOT_CHECK_UNAVAILABLE_REASONS.map((reason) => ({ result: 'unavailable' as const, reason })),
];

const HELP =
  'App Block review boot checks, one per review preview the check settled (after its retry). ' +
  'mode: shadow = recorded only, enforce = a failed check fails the preview and holds the app. ' +
  'result: passed | failed (no BLOCK_READY in the host window) | unavailable (the checker could ' +
  'not run). reason: why unavailable (contract = the checker refused the request, a bug; server ' +
  '= its 5xx; network; body; unconfigured; no-target; crash), none otherwise. Per-pod counter; ' +
  'read with range functions.';

function getOrCreateCounter(reg: Registry): Counter<string> {
  const existing = reg.getSingleMetric(APP_BLOCK_REVIEW_BOOT_CHECKS_METRIC) as
    | Counter<string>
    | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: APP_BLOCK_REVIEW_BOOT_CHECKS_METRIC,
    help: HELP,
    labelNames: ['mode', 'result', 'reason'],
    registers: [reg],
  });
}

/** Get-or-create the counter and seed every series at 0. Idempotent; `/api/metrics` calls it. */
export function ensureRegisterAppBlockBootCheckMetrics(reg: Registry = client.register): {
  bootChecksTotal: Counter<string>;
} {
  const bootChecksTotal = getOrCreateCounter(reg);
  for (const mode of MODES) for (const s of SERIES) bootChecksTotal.inc({ mode, ...s }, 0);
  return { bootChecksTotal };
}

/** Count one settled boot check. Never throws; a label pair outside the seeded set is dropped. */
export function recordReviewBootCheck(
  mode: ReviewBootCheckRecordedMode,
  result: ReviewBootCheckResult,
  reason: BootCheckReasonLabel
): void {
  try {
    if (!MODES.includes(mode)) return;
    if (!SERIES.some((s) => s.result === result && s.reason === reason)) return;
    getOrCreateCounter(client.register).inc({ mode, result, reason });
  } catch {
    // never throw from telemetry
  }
}
