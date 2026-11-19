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
  // Not routed: the viewer may see r/x listings, and the index holds the SFW audience only.
  'mature_viewer',
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
