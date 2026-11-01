/**
 * Most values a search facet (e.g. "Filter by Base Model") may list. Used BOTH as the `limit` of
 * the refinement lists on /search/models and /search/images AND as the Meilisearch index's
 * `faceting.maxValuesPerFacet` (set in onIndexSetup). Meilisearch defaults the index cap to 100 and
 * returns the first N values alphabetically, so a facet with more values silently drops the
 * alphabetical tail. Keep this above the number of base models; the test next to this file enforces it.
 * Lives in shared/ so client pages and server setup can import it without server code in the bundle.
 */
export const SEARCH_FACET_LIMIT = 250;
