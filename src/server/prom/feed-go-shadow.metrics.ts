import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// ---------------------------------------------------------------------------
// feed-go shadow samples (see `~/server/trpc/feed-go-shadow.ts`)
// ---------------------------------------------------------------------------
//
// One increment per SAMPLED `image.getImagesAsPostsInfinite` request, by what became of the
// sample. Requests that were not sampled are not counted. Labels: `outcome` only, a member of
// the fixed set below, so cardinality is bounded by construction.
//
// Registered on `instrumentationRegistry`, which `/api/metrics` merges into the scrape, so it is
// scraped whichever webpack graph registers it first (the importer, `~/server/trpc/feed-go-shadow.ts`,
// is reached from both the route and the server transformer in `src/server/trpc.ts`).

export const FEED_GO_SHADOW_OUTCOMES = [
  // POSTed and feed-go answered 2xx.
  'sent',
  // POSTed and feed-go answered non-2xx.
  'rejected',
  // The POST timed out (FEED_GO_SHADOW_TIMEOUT_MS).
  'timeout',
  // The POST failed (connection refused, DNS, reset, ...).
  'error',
  // Sampled, but FEED_GO_SHADOW_MAX_IN_FLIGHT samples were already in flight: dropped.
  'dropped_overload',
  // Sampled, but Node did not answer 200 (an error or a client abort): nothing to compare.
  'skipped_status',
  // Sampled, but no response body was captured at serialize time.
  'skipped_no_capture',
  // Building the payload threw.
  'skipped_encode',
] as const;

export type FeedGoShadowOutcome = (typeof FEED_GO_SHADOW_OUTCOMES)[number];

const NAME = 'civitai_app_feed_go_shadow_samples_total';

const feedGoShadowCounter = registerInstrumentationMetric(
  NAME,
  () =>
    new client.Counter({
      name: NAME,
      help:
        'Sampled image.getImagesAsPostsInfinite requests mirrored to the feed-go shadow ' +
        'comparator, by outcome. Only sampled requests are counted (flag feed-go-shadow on, ' +
        'FEED_GO_SHADOW_URL set, FEED_GO_SHADOW_SAMPLE_RATE > 0).',
      labelNames: ['outcome'],
      registers: [instrumentationRegistry],
    })
);

// Seed every outcome at 0 so "none" reads as 0 rather than as an absent series.
try {
  for (const outcome of FEED_GO_SHADOW_OUTCOMES) feedGoShadowCounter.inc({ outcome }, 0);
} catch {
  /* never throw from telemetry */
}

/** Count one sample's outcome. Never throws. */
export function recordFeedGoShadowOutcome(outcome: FeedGoShadowOutcome): void {
  try {
    feedGoShadowCounter.inc({ outcome });
  } catch {
    /* never throw from telemetry */
  }
}
