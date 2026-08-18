import type { AppsStoreFilters } from '~/components/Apps/appsStoreQueryParams';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import { FEEDBACK_FILTER_VALUE_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * The triage payload the `/apps` marketplace feedback prompt sends with a report.
 *
 * A one-line report ("the list is empty") is only actionable next to the view it was
 * written about, and on this page the view is entirely determined by the URL — kind,
 * category, sort and the free-text search box all live in the query string (see
 * `useAppsStoreQueryParams`). So the context is a straight read of the resolved
 * filter state, and it is deliberately built HERE rather than inline in the page:
 * the clipping below is load-bearing and needs to be reachable by a test.
 *
 * 🔴 WHY `query` IS CLIPPED. `feedbackContextSchema.filters` bounds each value at
 * `FEEDBACK_FILTER_VALUE_MAX_LENGTH`, and a zod `max()` REJECTS — it does not
 * truncate. `query` is whatever the viewer typed into the search box (echoed into
 * `?query=`, and hand-editable in the address bar), so passing it through unclipped
 * makes a long search term fail the whole submission with a validation error the
 * reporter cannot act on, on the one surface that exists to accept reports. The
 * report is worth more than the tail of a search term.
 *
 * Everything else is a closed set (`kind`, `sort`) or a known enum member
 * (`category`), so none of them can exceed the bound.
 */
export function buildAppsStoreFeedbackContext({
  filters,
  path,
}: {
  filters: AppsStoreFilters;
  /** `window.location.pathname`, or undefined during SSR. */
  path?: string;
}): CreateFeedbackInput['context'] {
  return {
    path,
    filters: {
      kind: filters.kind,
      // `null` is the "no category selected" state, and the context schema's value
      // union is string | number | boolean — so this cannot be passed through, and
      // `?? undefined` is not a fix either: an explicit `undefined` is a RECORD
      // VALUE here and fails the union, taking the whole submission with it. Said in
      // words instead: a missing key would read as "we don't know" in triage, which
      // is a different claim from "the viewer had no category selected".
      category: filters.category ?? 'none',
      sort: filters.sort,
      query: filters.query.slice(0, FEEDBACK_FILTER_VALUE_MAX_LENGTH),
    },
  };
}
