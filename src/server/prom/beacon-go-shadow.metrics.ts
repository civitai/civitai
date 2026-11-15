import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// beacon-go shadow samples (see `~/server/beacon/beacon-go-shadow.ts`).
//
// One increment per SAMPLED beacon request, by what became of the sample. Requests that were not
// sampled are not counted. Labels: `outcome`, from the fixed set below, and `beacon_endpoint`
// (ping | pulse). Not `endpoint`: that is a reserved scrape target label, which would move ours to
// `exported_endpoint` (as for feed-go's `feed_endpoint`). beacon-go's own beacon_go_* series use the
// same label name.

export const BEACON_GO_SHADOW_OUTCOMES = [
  // POSTed and beacon-go answered 2xx.
  'sent',
  // POSTed and beacon-go answered non-2xx.
  'rejected',
  // The POST timed out (BEACON_GO_SHADOW_TIMEOUT_MS).
  'timeout',
  // The POST failed (connection refused, DNS, reset, ...).
  'error',
  // Sampled, but BEACON_GO_SHADOW_MAX_IN_FLIGHT samples were already in flight: dropped.
  'dropped_overload',
  // Sampled, but BEACON_GO_SHADOW_MAX_PER_SECOND samples already began this second: dropped.
  'dropped_rate_limit',
  // Building the payload threw.
  'skipped_encode',
] as const;

export type BeaconGoShadowOutcome = (typeof BEACON_GO_SHADOW_OUTCOMES)[number];

export const BEACON_GO_SHADOW_ENDPOINTS = ['ping', 'pulse'] as const;
export type BeaconGoShadowEndpoint = (typeof BEACON_GO_SHADOW_ENDPOINTS)[number];

const NAME = 'civitai_app_beacon_go_shadow_samples_total';

const beaconGoShadowCounter = registerInstrumentationMetric(
  NAME,
  () =>
    new client.Counter({
      name: NAME,
      help:
        'Sampled /api/internal/ping and /api/internal/pulse requests mirrored to the beacon-go ' +
        'shadow comparator (flag beacon-go-shadow), by outcome and endpoint. Only sampled requests ' +
        'are counted (BEACON_GO_SHADOW_URL set, BEACON_GO_SHADOW_SAMPLE_RATE > 0).',
      labelNames: ['outcome', 'beacon_endpoint'],
      registers: [instrumentationRegistry],
    })
);

// Seed every outcome at 0 so "none" reads as 0 rather than as an absent series.
try {
  for (const endpoint of BEACON_GO_SHADOW_ENDPOINTS) {
    for (const outcome of BEACON_GO_SHADOW_OUTCOMES) {
      beaconGoShadowCounter.inc({ outcome, beacon_endpoint: endpoint }, 0);
    }
  }
} catch {
  /* never throw from telemetry */
}

/** Count one sample's outcome. Never throws. */
export function recordBeaconGoShadowOutcome(
  outcome: BeaconGoShadowOutcome,
  endpoint: BeaconGoShadowEndpoint
): void {
  try {
    beaconGoShadowCounter.inc({ outcome, beacon_endpoint: endpoint });
  } catch {
    /* never throw from telemetry */
  }
}
