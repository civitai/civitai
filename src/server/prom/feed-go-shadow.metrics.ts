import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// ---------------------------------------------------------------------------
// feed-go shadow samples (see `~/server/trpc/feed-go-shadow.ts`)
// ---------------------------------------------------------------------------
//
// One increment per SAMPLED request, by what became of the sample. Requests that were not sampled
// are not counted. Labels: `outcome`, a member of the fixed set below, and `endpoint`, one of
// FEED_GO_SHADOW_ENDPOINTS, so cardinality is bounded by construction.
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
  // Sampled, but FEED_GO_SHADOW_MAX_PER_SECOND samples already began this second: dropped.
  'dropped_rate_limit',
  // Sampled, but Node did not answer 200 (an error or a client abort): nothing to compare.
  'skipped_status',
  // Sampled, but no response body was captured at serialize time.
  'skipped_no_capture',
  // Building the payload threw.
  'skipped_encode',
  // Sampled, but the request carried an API credential (REST only): not mirrored, because Node's
  // response can echo it (`metadata.nextPage` keeps `?token=`), and feed-go falls back on any
  // credential anyway. Counted so that share of the traffic is still visible.
  'skipped_credential',
] as const;

export type FeedGoShadowOutcome = (typeof FEED_GO_SHADOW_OUTCOMES)[number];

/** The mirrored routes, as feed-go labels them (`endpoint` on its feed_go_* series too). */
export const FEED_GO_SHADOW_ENDPOINTS = ['as-posts', 'v1-images'] as const;
export type FeedGoShadowEndpoint = (typeof FEED_GO_SHADOW_ENDPOINTS)[number];

const NAME = 'civitai_app_feed_go_shadow_samples_total';

const feedGoShadowCounter = registerInstrumentationMetric(
  NAME,
  () =>
    new client.Counter({
      name: NAME,
      help:
        'Sampled requests mirrored to the feed-go shadow comparator, by outcome and endpoint ' +
        '(as-posts: image.getImagesAsPostsInfinite, flag feed-go-shadow; v1-images: GET ' +
        '/api/v1/images, flag feed-go-shadow-v1-images). Only sampled requests are counted ' +
        '(FEED_GO_SHADOW_URL set, FEED_GO_SHADOW_SAMPLE_RATE > 0).',
      labelNames: ['outcome', 'endpoint'],
      registers: [instrumentationRegistry],
    })
);

// Seed every outcome at 0 so "none" reads as 0 rather than as an absent series.
try {
  for (const endpoint of FEED_GO_SHADOW_ENDPOINTS) {
    for (const outcome of FEED_GO_SHADOW_OUTCOMES) {
      feedGoShadowCounter.inc({ outcome, endpoint }, 0);
    }
  }
} catch {
  /* never throw from telemetry */
}

/** Count one sample's outcome. Never throws. */
export function recordFeedGoShadowOutcome(
  outcome: FeedGoShadowOutcome,
  endpoint: FeedGoShadowEndpoint = 'as-posts'
): void {
  try {
    feedGoShadowCounter.inc({ outcome, endpoint });
  } catch {
    /* never throw from telemetry */
  }
}

// The synchronous encode work the sampler adds to the event loop, after the sampled response is
// written (`superjson.serialize` for a devalue response, then `JSON.stringify`). Two counters,
// labelled by `endpoint` only: seconds of encode time and bytes of request body. Divide by the
// `sent` + `rejected` + `timeout` + `error` outcomes of the same endpoint for a per-sample cost.

const ENCODE_SECONDS = 'civitai_app_feed_go_shadow_encode_seconds_total';
const ENCODE_BYTES = 'civitai_app_feed_go_shadow_encode_bytes_total';

const encodeSecondsCounter = registerInstrumentationMetric(
  ENCODE_SECONDS,
  () =>
    new client.Counter({
      name: ENCODE_SECONDS,
      help:
        'Seconds of synchronous event-loop time spent encoding feed-go shadow samples ' +
        '(after the sampled response was written).',
      labelNames: ['endpoint'],
      registers: [instrumentationRegistry],
    })
);

const encodeBytesCounter = registerInstrumentationMetric(
  ENCODE_BYTES,
  () =>
    new client.Counter({
      name: ENCODE_BYTES,
      help: 'Bytes of request body encoded for feed-go shadow samples.',
      labelNames: ['endpoint'],
      registers: [instrumentationRegistry],
    })
);

/** Count one sample's encode cost. Never throws. */
export function recordFeedGoShadowEncode(
  seconds: number,
  bytes: number,
  endpoint: FeedGoShadowEndpoint = 'as-posts'
): void {
  try {
    if (seconds > 0) encodeSecondsCounter.inc({ endpoint }, seconds);
    if (bytes > 0) encodeBytesCounter.inc({ endpoint }, bytes);
  } catch {
    /* never throw from telemetry */
  }
}
