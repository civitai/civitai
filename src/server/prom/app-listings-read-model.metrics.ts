import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';
import {
  APP_INDEX_BREAKER_STATES,
  type AppIndexBreakerState,
} from '~/server/prom/app-index-search.metrics';

// The listings read model's serve and shadow counters (`app-listings-read-model-shadow.service.ts`). Every
// label is from a fixed set: no slug, no query, no user. Which of them gate serving:
// `apps/app-index-go/LISTINGS-READ-MODEL.md`, "Go / no-go for serving". Registered on
// `instrumentationRegistry`, which `/api/metrics` merges into the scrape.

export const READ_MODEL_SURFACES = ['grid', 'rest_list'] as const;
export type ReadModelSurface = (typeof READ_MODEL_SURFACES)[number];

export const READ_MODEL_SHADOW_OUTCOMES = [
  // Both answers were read and compared.
  'compared',
  // Not asked: APP_INDEX_URL is unset, or APP_INDEX_VIEWER_KEY is unset or shorter than 32 bytes.
  'unconfigured',
  // Not asked: the viewer's floor is not `public`, or their level cannot be signed exactly.
  'unsupported_viewer',
  // Not asked: a page the read model does not answer (a page the app index's search answered, or
  // a cursor that names no card).
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
  // The shadow's own database read (the by-slug check of a difference) failed, or outlived the
  // shadow timeout. Not a read-model failure: a failed read does not move the breaker; a timeout
  // counts toward opening it, as a slow read model does.
  'db_error',
  'db_timeout',
] as const;
export type ReadModelShadowOutcome = (typeof READ_MODEL_SHADOW_OUTCOMES)[number];

/**
 * Per listing, how its two answers differed:
 *   - visibility_missing: on the database page, and the read model does not show it to this
 *     viewer at all (asked by slug);
 *   - visibility_extra: on the read-model page, and the database does not show it to this viewer
 *     at all (asked by slug). The one that would show a viewer a listing it must not see;
 *   - media: on both pages, with a different gated icon or cover;
 *   - identity_field: on both pages, with an identity field different (READ_MODEL_FIELD_CLASS):
 *     what the card says the listing is. Gating, with visibility and media;
 *   - stats_field: on both pages, with a stats field different: counters and times that trail the
 *     database by up to an adapter poll. Reported, not gating.
 * Which fields differed: `app_listings_read_model_field_mismatches_total`.
 * A listing on one page only that the other side also admits is not here: it is a paging or
 * ordering difference, counted in `app_listings_read_model_order_mismatches_total`.
 */
export const READ_MODEL_MISMATCH_KINDS = [
  'visibility_missing',
  'visibility_extra',
  'media',
  'identity_field',
  'stats_field',
  // A sub-listing card on the database page only, of a listing whose stream left items out past
  // the adapter's per-listing cap (MAX_STREAM_SUB_LISTINGS): a known difference. Reported, not
  // gating; a listing over the cap is served without its oldest items.
  'sub_listing_cap',
] as const;
export type ReadModelMismatchKind = (typeof READ_MODEL_MISMATCH_KINDS)[number];

/**
 * The card fields compared for a card on both pages. `iconUrl` and `coverUrl` are media; `id` is
 * a slug that names a different listing on each side (or an id that names a listing on one side and
 * a sub-listing on the other). `kind`, `parent`, `parentIconUrl` and `runHref` are a sub-listing
 * card's own (`SubListingCard`); the rest it shares with a listing card where it has them.
 */
export const READ_MODEL_COMPARED_FIELDS = [
  'id',
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
  'kind',
  'parent',
  'parentIconUrl',
  'runHref',
] as const;
export type ReadModelComparedField = (typeof READ_MODEL_COMPARED_FIELDS)[number];

/**
 * Each compared field's class, which decides the mismatch kind it counts toward:
 *   - media: the gated icon and cover;
 *   - identity: what the card says the listing is, its creator and its flags; a difference is a
 *     read-model bug, never staleness, so it gates serving with visibility and media;
 *   - stats: the rollup counters and the updated time, which may trail the database by up to an
 *     adapter poll; reported, not gating.
 * A Record, so a field added to READ_MODEL_COMPARED_FIELDS does not compile until it is classed.
 */
export const READ_MODEL_FIELD_CLASS: Readonly<
  Record<ReadModelComparedField, 'media' | 'identity' | 'stats'>
> = {
  iconUrl: 'media',
  coverUrl: 'media',
  // A sub-listing card's parent icon, gated at the card's ceiling.
  parentIconUrl: 'media',
  // One slug naming a different listing id on each side.
  id: 'identity',
  name: 'identity',
  tagline: 'identity',
  category: 'identity',
  contentRating: 'identity',
  creator: 'identity',
  isBeta: 'identity',
  isOfficial: 'identity',
  kindData: 'identity',
  // A sub-listing card's kind (its parent's), parent (id, slug, name) and link.
  kind: 'identity',
  parent: 'identity',
  runHref: 'identity',
  recommendedCount: 'stats',
  notRecommendedCount: 'stats',
  recommendPct: 'stats',
  reviewCount: 'stats',
  openCount: 'stats',
  updatedAt: 'stats',
};

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
  'Cards compared (listings and sub-listings, on either page), by surface: the denominator of the mismatch rates.',
  ['surface']
);
const mismatches = counter(
  'app_listings_read_model_mismatches_total',
  'Compared cards whose answers differed, by surface and kind (visibility_missing, ' +
    'visibility_extra, media, identity_field, stats_field).',
  ['surface', 'kind']
);
const fieldMismatches = counter(
  'app_listings_read_model_field_mismatches_total',
  'Card fields that differed for a card on both pages, by surface and field.',
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

/**
 * With the flag at `serve`, where each store grid or public REST list page was read from. `served`
 * is the read model; every other outcome is the database, and says why.
 */
export const READ_MODEL_SERVE_OUTCOMES = [
  // The read model answered and its page was served.
  'served',
  // Not asked: APP_INDEX_URL is unset, or APP_INDEX_VIEWER_KEY is unset or shorter than 32 bytes.
  'unconfigured',
  // Not asked: the viewer is a moderator, their floor is not `public`, or their level cannot be
  // signed exactly.
  'unsupported_viewer',
  // Not asked: a cursor that names no card.
  'unsupported_input',
  // Not asked: the breaker is open after consecutive read-model failures.
  'breaker_open',
  // Asked, and the read model gave no usable answer: no answer within the serve timeout, a 503,
  // another failure, or a body that is not a servable page.
  'timeout',
  'not_ready',
  'error',
  'bad_response',
] as const;
export type ReadModelServeOutcome = (typeof READ_MODEL_SERVE_OUTCOMES)[number];

const serveRequests = counter(
  'app_listings_read_model_serve_requests_total',
  'Store pages with the app-listings-read-model flag at serve, by surface and where they were ' +
    'read from (served = the read model; any other outcome = the database, and why).',
  ['surface', 'outcome']
);

export function recordReadModelServe(surface: ReadModelSurface, outcome: ReadModelServeOutcome) {
  serveRequests.inc({ surface, outcome });
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
      help: 'Listings read-model breaker state (serve and shadow) in this process: 0 closed, 1 half-open, 2 open.',
      registers: [instrumentationRegistry],
    })
);
const breakerTransitions = counter(
  'app_listings_read_model_breaker_transitions_total',
  'Listings read-model breaker (serve and shadow) state changes, by the state entered.',
  ['to']
);

export function recordReadModelBreakerTransition(to: AppIndexBreakerState) {
  breakerState.set(APP_INDEX_BREAKER_STATES[to]);
  breakerTransitions.inc({ to });
}
