import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// ---------------------------------------------------------------------------
// feed-go shadow samples (see `~/server/trpc/feed-go-shadow.ts`)
// ---------------------------------------------------------------------------
//
// One increment per SAMPLED request, by what became of the sample. Requests that were not sampled
// are not counted. Labels: `outcome`, a member of the fixed set below, and `feed_endpoint`, one of
// FEED_GO_SHADOW_ENDPOINTS, so cardinality is bounded by construction.
//
// The label is not called `endpoint`: that is a reserved scrape target label (the
// scraper's target label), which overwrites a series' own `endpoint` and moves ours to
// `exported_endpoint`. feed-go's feed_go_* series use the same name.
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
  // Reading the response's headers (res.getHeaders) threw: not sent, since the header comparison
  // would be lost without a trace.
  'skipped_headers',
  // Sampled, but the request carried an API credential (REST only): not mirrored, because Node's
  // response can echo it (`metadata.nextPage` keeps `?token=`), and feed-go falls back on any
  // credential anyway. Counted so that share of the traffic is still visible.
  'skipped_credential',
] as const;

export type FeedGoShadowOutcome = (typeof FEED_GO_SHADOW_OUTCOMES)[number];

/** The mirrored routes, as feed-go labels them (`feed_endpoint` on its feed_go_* series too). */
export const FEED_GO_SHADOW_ENDPOINTS = [
  'as-posts',
  'v1-images',
  'infinite',
  'model-getall',
  'v1-models',
  'v1-models-id',
  'model-associated',
  'site-search',
] as const;
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
        '/api/v1/images, flag feed-go-shadow-v1-images; infinite: image.getInfinite, flag ' +
        'feed-go-shadow-infinite; model-getall: model.getAll, flag feed-go-shadow-model-getall; ' +
        'v1-models / v1-models-id: GET /api/v1/models and /api/v1/models/[id], flag ' +
        'feed-go-shadow-v1-models; model-associated: model.getAssociatedResourcesCardData, flag ' +
        'feed-go-shadow-model-associated; site-search: POST /api/search/*, flag ' +
        'feed-go-shadow-site-search). Only sampled requests are counted ' +
        '(FEED_GO_SHADOW_URL set, FEED_GO_SHADOW_SAMPLE_RATE > 0).',
      labelNames: ['outcome', 'feed_endpoint'],
      registers: [instrumentationRegistry],
    })
);

// Seed every outcome at 0 so "none" reads as 0 rather than as an absent series.
try {
  for (const endpoint of FEED_GO_SHADOW_ENDPOINTS) {
    for (const outcome of FEED_GO_SHADOW_OUTCOMES) {
      feedGoShadowCounter.inc({ outcome, feed_endpoint: endpoint }, 0);
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
    feedGoShadowCounter.inc({ outcome, feed_endpoint: endpoint });
  } catch {
    /* never throw from telemetry */
  }
}

// ---------------------------------------------------------------------------
// feed-go Go-first probes (flag `feed-go-gofirst-probe`, see `~/server/trpc/feed-go-shadow.ts`)
// ---------------------------------------------------------------------------
//
// One increment per PROBED request, by what became of the probe POST. feed-go's own
// `feed_go_gofirst_total` counts what the probe found; this counts what reached it.

export const FEED_GO_PROBE_OUTCOMES = [
  // POSTed and feed-go answered 2xx.
  'sent',
  // POSTed and feed-go answered non-2xx.
  'rejected',
  // The POST timed out (FEED_GO_SHADOW_TIMEOUT_MS).
  'timeout',
  // The POST failed (connection refused, DNS, reset, ...).
  'error',
  // Probed, but FEED_GO_SHADOW_MAX_IN_FLIGHT posts were already in flight: not sent.
  'dropped_overload',
] as const;

export type FeedGoProbeOutcome = (typeof FEED_GO_PROBE_OUTCOMES)[number];

const PROBE_NAME = 'civitai_app_feed_go_gofirst_probe_total';

const feedGoProbeCounter = registerInstrumentationMetric(
  PROBE_NAME,
  () =>
    new client.Counter({
      name: PROBE_NAME,
      help:
        'Go-first probes posted to feed-go at the start of a sampled request, by outcome and ' +
        'endpoint (flag feed-go-gofirst-probe, FEED_GO_GOFIRST_PROBE_SAMPLE_RATE > 0; v1-images: ' +
        'FEED_GO_GOFIRST_PROBE_V1_IMAGES_SAMPLE_RATE > 0).',
      labelNames: ['outcome', 'feed_endpoint'],
      registers: [instrumentationRegistry],
    })
);

try {
  for (const endpoint of ['as-posts', 'infinite', 'model-getall', 'v1-images'] as const) {
    for (const outcome of FEED_GO_PROBE_OUTCOMES) {
      feedGoProbeCounter.inc({ outcome, feed_endpoint: endpoint }, 0);
    }
  }
} catch {
  /* never throw from telemetry */
}

/** Count one probe's outcome. Never throws. */
export function recordFeedGoProbeOutcome(
  outcome: FeedGoProbeOutcome,
  endpoint: FeedGoShadowEndpoint = 'as-posts'
): void {
  try {
    feedGoProbeCounter.inc({ outcome, feed_endpoint: endpoint });
  } catch {
    /* never throw from telemetry */
  }
}

// The synchronous encode work the sampler adds to the event loop, after the sampled response is
// written (`superjson.serialize` for a devalue response, then `JSON.stringify`). Two counters,
// labelled by `feed_endpoint` only: seconds of encode time and bytes of request body. Divide by the
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
      labelNames: ['feed_endpoint'],
      registers: [instrumentationRegistry],
    })
);

const encodeBytesCounter = registerInstrumentationMetric(
  ENCODE_BYTES,
  () =>
    new client.Counter({
      name: ENCODE_BYTES,
      help: 'Bytes of request body encoded for feed-go shadow samples.',
      labelNames: ['feed_endpoint'],
      registers: [instrumentationRegistry],
    })
);

try {
  for (const endpoint of FEED_GO_SHADOW_ENDPOINTS) {
    encodeSecondsCounter.inc({ feed_endpoint: endpoint }, 0);
    encodeBytesCounter.inc({ feed_endpoint: endpoint }, 0);
  }
} catch {
  /* never throw from telemetry */
}

/** Count one sample's encode cost. Never throws. */
export function recordFeedGoShadowEncode(
  seconds: number,
  bytes: number,
  endpoint: FeedGoShadowEndpoint = 'as-posts'
): void {
  try {
    if (seconds > 0) encodeSecondsCounter.inc({ feed_endpoint: endpoint }, seconds);
    if (bytes > 0) encodeBytesCounter.inc({ feed_endpoint: endpoint }, bytes);
  } catch {
    /* never throw from telemetry */
  }
}

// ---------------------------------------------------------------------------
// Every GET /api/v1/images request, by shape class (sampled or not, flag on or off)
// ---------------------------------------------------------------------------
//
// The share of the route feed-go's port can answer at all: `ported` over the total. A shape it
// falls back on by construction (the legacy Postgres path, tags, a query key outside the schema,
// ...), an API-key request, and a non-200 answer each have their own class. Labels: `class` only,
// from the fixed set below.

export const FEED_GO_V1_SHAPE_CLASSES = [
  'ported',
  'unported_imageId',
  'unported_modelId_only',
  'unported_tags',
  'unported_baseModels',
  'unported_withTags',
  'unported_unknownKey',
  'api_key',
  'non200',
] as const;

export type FeedGoV1ShapeClass = (typeof FEED_GO_V1_SHAPE_CLASSES)[number];

const SHAPE_NAME = 'civitai_app_feed_go_v1_shape_total';

const v1ShapeCounter = registerInstrumentationMetric(
  SHAPE_NAME,
  () =>
    new client.Counter({
      name: SHAPE_NAME,
      help:
        'GET /api/v1/images requests by shape class: ported (a shape feed-go answers), the ' +
        'unported_* shapes it falls back on by construction (unported_unknownKey: a query key ' +
        'outside the schema, which feed-go falls back on), api_key, and non200.',
      labelNames: ['class'],
      registers: [instrumentationRegistry],
    })
);

try {
  for (const shape of FEED_GO_V1_SHAPE_CLASSES) v1ShapeCounter.inc({ class: shape }, 0);
} catch {
  /* never throw from telemetry */
}

/** Count one /api/v1/images request's shape class. Never throws. */
export function recordFeedGoV1Shape(shape: FeedGoV1ShapeClass): void {
  try {
    v1ShapeCounter.inc({ class: shape });
  } catch {
    /* never throw from telemetry */
  }
}
