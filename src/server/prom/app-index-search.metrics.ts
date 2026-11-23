import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// ---------------------------------------------------------------------------
// App index store search (see `~/server/services/blocks/app-index-search.service.ts`)
// ---------------------------------------------------------------------------
//
// One increment per store search request the `app-index-search` flag is on for. `source` says who
// answered (`index` or `db_fallback`), `reason` why (a member of APP_INDEX_SEARCH_REASONS), so
// cardinality is bounded by construction. No query text, no user.
//
// Registered on `instrumentationRegistry`, which `/api/metrics` merges into the scrape.

export const APP_INDEX_SEARCH_REASONS = [
  // The index answered.
  'ok',
  // Not routed to the index: APP_INDEX_URL is unset.
  'no_url',
  // Not routed: the viewer's audience floor is above `public` (testers, moderators), so the
  // database grid may show them listings that are not public, which the index does not answer.
  'unsupported_viewer',
  // Not routed: a developer-filtered or paged request, which the index cannot answer.
  'unsupported_input',
  // The index call timed out (APP_INDEX_SEARCH_TIMEOUT_MS).
  'timeout',
  // The index answered 503: it has not reached its first Live yet.
  'not_ready',
  // The index answered another non-2xx status, or the call failed.
  'error',
  // The index answered 2xx with a body that is not a search response.
  'bad_response',
  // Not sent: the breaker is open after consecutive index failures (`IndexBreaker`).
  'breaker_open',
  // The index answered, but a database read the answer needed failed. Not an index failure: it
  // never moves the breaker.
  'db_error',
] as const;
export type AppIndexSearchReason = (typeof APP_INDEX_SEARCH_REASONS)[number];

export type AppIndexSearchSource = 'index' | 'db_fallback';

const NAME = 'civitai_app_index_search_requests_total';

const appIndexSearchCounter = registerInstrumentationMetric(
  NAME,
  () =>
    new client.Counter({
      name: NAME,
      help:
        'Store searches with the app-index-search flag on, by who answered (index | db_fallback) ' +
        'and why.',
      labelNames: ['source', 'reason'],
      registers: [instrumentationRegistry],
    })
);

export function recordAppIndexSearch(source: AppIndexSearchSource, reason: AppIndexSearchReason) {
  appIndexSearchCounter.inc({ source, reason });
}

/** The breaker's states, as the gauge's values. */
export const APP_INDEX_BREAKER_STATES = { closed: 0, half_open: 1, open: 2 } as const;
export type AppIndexBreakerState = keyof typeof APP_INDEX_BREAKER_STATES;

const BREAKER_STATE = 'civitai_app_index_search_breaker_state';

// Per process: the state of this process's breaker around the index call, as
// APP_INDEX_BREAKER_STATES. 0 (closed) until the first transition.
const breakerStateGauge = registerInstrumentationMetric(
  BREAKER_STATE,
  () =>
    new client.Gauge({
      name: BREAKER_STATE,
      help: 'App index search breaker state in this process: 0 closed, 1 half-open, 2 open.',
      registers: [instrumentationRegistry],
    })
);

const BREAKER_TRANSITIONS = 'civitai_app_index_search_breaker_transitions_total';

// One increment per breaker state change, by the state entered. An open that closes again
// between two scrapes never shows on the gauge; it shows here.
const breakerTransitionsCounter = registerInstrumentationMetric(
  BREAKER_TRANSITIONS,
  () =>
    new client.Counter({
      name: BREAKER_TRANSITIONS,
      help: 'App index search breaker state changes, by the state entered.',
      labelNames: ['to'],
      registers: [instrumentationRegistry],
    })
);

export function recordAppIndexBreakerTransition(to: AppIndexBreakerState) {
  breakerStateGauge.set(APP_INDEX_BREAKER_STATES[to]);
  breakerTransitionsCounter.inc({ to });
}

/** The app entity fields the index returns that map onto a store card, compared per result. */
export const APP_INDEX_COMPARED_FIELDS = ['name', 'tagline', 'iconUrl', 'rating'] as const;
export type AppIndexComparedField = (typeof APP_INDEX_COMPARED_FIELDS)[number];

const FIELD_DIFFS = 'civitai_app_index_search_field_diffs_total';

// One increment per index result whose field differs from the store card the database hydrated
// for the same slug, by field. Differences with a known cause (see `compareIndexFields`) are not
// counted here. Counts only: no values.
const fieldDiffsCounter = registerInstrumentationMetric(
  FIELD_DIFFS,
  () =>
    new client.Counter({
      name: FIELD_DIFFS,
      help:
        'App index search results whose name, tagline, iconUrl or rating differs from the ' +
        'database-hydrated store card for the same slug (unexplained differences only), by field.',
      labelNames: ['field'],
      registers: [instrumentationRegistry],
    })
);

export function recordAppIndexSearchFieldDiffs(field: AppIndexComparedField, count: number) {
  if (count > 0) fieldDiffsCounter.inc({ field }, count);
}
