import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';
import {
  APP_INDEX_BREAKER_STATES,
  type AppIndexBreakerState,
} from '~/server/prom/app-index-search.metrics';

// ---------------------------------------------------------------------------
// Listings read-model shadow (see `~/server/services/blocks/app-listings-read-model-shadow.service.ts`)
// ---------------------------------------------------------------------------
//
// With the `app-listings-read-model` flag on, a sampled fraction of store grid pages and public
// REST list pages is also asked of the app index's read model, off the response path, and the two
// answers are compared. Every label is from a fixed set, so cardinality is bounded by
// construction: no slug, no query, no user.
//
// Serving gate (LISTINGS-READ-MODEL.md, "Shadow diff"): over 7 days,
//   (mismatches{kind=~"visibility_.*|media"}) / compared_slugs  < 0.1 %, per surface.
// Order and field mismatches are reported beside it and do not gate.
//
// Registered on `instrumentationRegistry`, which `/api/metrics` merges into the scrape.

export const READ_MODEL_SURFACES = ['grid', 'rest_list'] as const;
export type ReadModelSurface = (typeof READ_MODEL_SURFACES)[number];

export const READ_MODEL_SHADOW_OUTCOMES = [
  // Both answers were read and compared.
  'compared',
  // Not asked: APP_INDEX_URL is unset, or APP_INDEX_VIEWER_KEY is unset or shorter than 32 bytes.
  'unconfigured',
  // Not asked: the viewer's floor is not `public`, or their level cannot be signed exactly.
  'unsupported_viewer',
  // Not asked: a page the read model does not answer (sub-listing cards on it, a page the app
  // index's search answered, or a cursor whose listing can no longer be named).
  'unsupported_input',
  // Not asked: the breaker is open after consecutive read-model failures.
  'breaker_open',
  // Not asked: this process already has the maximum number of shadow reads in flight.
  'saturated',
  // The read model did not answer within the shadow timeout.
  'timeout',
  // The read model answered 503 (no serving generation yet, or a generation switch).
  'not_ready',
  // The read model answered another non-2xx status, or the call failed.
  'error',
  // The read model answered 2xx with a body that is not a listing page.
  'bad_response',
  // The read model answered, but the database read that checks a difference failed. Not a
  // read-model failure: it never moves the breaker.
  'db_error',
] as const;
export type ReadModelShadowOutcome = (typeof READ_MODEL_SHADOW_OUTCOMES)[number];

/**
 * Per listing, how its two answers differed:
 *   - visibility_missing: on the database page, and the read model does not show it to this
 *     viewer at all (asked by slug);
 *   - visibility_extra: on the read-model page, and the database does not show it to this viewer
 *     at all (asked by slug). The one that would show a viewer a listing it must not see;
 *   - media: on both pages, with a different gated icon or cover;
 *   - field: on both pages, with another card field different (which ones:
 *     `app_listings_read_model_field_mismatches_total`).
 * A listing on one page only that the other side also admits is not here: it is a paging or
 * ordering difference, counted in `app_listings_read_model_order_mismatches_total`.
 */
export const READ_MODEL_MISMATCH_KINDS = [
  'visibility_missing',
  'visibility_extra',
  'media',
  'field',
] as const;
export type ReadModelMismatchKind = (typeof READ_MODEL_MISMATCH_KINDS)[number];

/** The card fields compared for a listing on both pages. `iconUrl` and `coverUrl` are media. */
export const READ_MODEL_COMPARED_FIELDS = [
  'name',
  'tagline',
  'category',
  'contentRating',
  'iconUrl',
  'coverUrl',
  'creator',
  'recommendedCount',
  'notRecommendedCount',
  'recommendPct',
  'reviewCount',
  'isBeta',
  'isOfficial',
  'openCount',
  'updatedAt',
  'kindData',
] as const;
export type ReadModelComparedField = (typeof READ_MODEL_COMPARED_FIELDS)[number];
export const READ_MODEL_MEDIA_FIELDS: readonly ReadModelComparedField[] = ['iconUrl', 'coverUrl'];

function counter(name: string, help: string, labelNames: string[]) {
  return registerInstrumentationMetric(
    name,
    () => new client.Counter({ name, help, labelNames, registers: [instrumentationRegistry] })
  );
}

const shadowRequests = counter(
  'app_listings_read_model_shadow_requests_total',
  'Sampled store pages with the app-listings-read-model flag on, by surface and what the shadow did.',
  ['surface', 'outcome']
);
const comparedPages = counter(
  'app_listings_read_model_compared_pages_total',
  'Pages whose database and read-model answers were compared, by surface.',
  ['surface']
);
const comparedSlugs = counter(
  'app_listings_read_model_compared_slugs_total',
  'Listings compared (on either page), by surface: the denominator of the mismatch rates.',
  ['surface']
);
const mismatches = counter(
  'app_listings_read_model_mismatches_total',
  'Compared listings whose answers differed, by surface and kind (visibility_missing, ' +
    'visibility_extra, media, field).',
  ['surface', 'kind']
);
const fieldMismatches = counter(
  'app_listings_read_model_field_mismatches_total',
  'Card fields that differed for a listing on both pages, by surface and field.',
  ['surface', 'field']
);
const orderMismatches = counter(
  'app_listings_read_model_order_mismatches_total',
  'Compared pages whose listings (less any visibility mismatch) differ in order or page ' +
    'boundary, or whose next-page presence differs, by surface. Reported, not gating.',
  ['surface']
);

export function recordReadModelShadow(surface: ReadModelSurface, outcome: ReadModelShadowOutcome) {
  shadowRequests.inc({ surface, outcome });
}

export type ReadModelComparison = {
  slugs: number;
  kinds: Record<ReadModelMismatchKind, number>;
  fields: Partial<Record<ReadModelComparedField, number>>;
  order: boolean;
};

export function recordReadModelComparison(surface: ReadModelSurface, c: ReadModelComparison) {
  comparedPages.inc({ surface });
  if (c.slugs > 0) comparedSlugs.inc({ surface }, c.slugs);
  for (const kind of READ_MODEL_MISMATCH_KINDS) {
    if (c.kinds[kind] > 0) mismatches.inc({ surface, kind }, c.kinds[kind]);
  }
  for (const field of READ_MODEL_COMPARED_FIELDS) {
    const n = c.fields[field] ?? 0;
    if (n > 0) fieldMismatches.inc({ surface, field }, n);
  }
  if (c.order) orderMismatches.inc({ surface });
}

const BREAKER_STATE = 'app_listings_read_model_breaker_state';
const breakerState = registerInstrumentationMetric(
  BREAKER_STATE,
  () =>
    new client.Gauge({
      name: BREAKER_STATE,
      help: 'Listings read-model shadow breaker state in this process: 0 closed, 1 half-open, 2 open.',
      registers: [instrumentationRegistry],
    })
);
const breakerTransitions = counter(
  'app_listings_read_model_breaker_transitions_total',
  'Listings read-model shadow breaker state changes, by the state entered.',
  ['to']
);

export function recordReadModelBreakerTransition(to: AppIndexBreakerState) {
  breakerState.set(APP_INDEX_BREAKER_STATES[to]);
  breakerTransitions.inc({ to });
}
