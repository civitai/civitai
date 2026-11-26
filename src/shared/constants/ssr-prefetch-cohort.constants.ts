/**
 * Set on the page request by `getServerSideProps` (`~/server/utils/ssr-skip-prefetch`) when the
 * request is in an `ssrSignedInSkipPrefetch*` trial's population, to the arm it landed in. Read by
 * `_document`'s render-CPU metric, which Next runs after getServerSideProps. Here rather than in
 * `~/server/utils` so the metrics need no server import.
 */
export const SSR_PREFETCH_COHORT_REQ_KEY = 'civSsrPrefetchCohort';

/**
 * Set alongside the cohort, to the page pattern the adopting page names (`/models/[id]/[[...slug]]`):
 * the route label of the getServerSideProps CPU counter, which runs before Next has a `pathname`.
 */
export const SSR_PREFETCH_ROUTE_REQ_KEY = 'civSsrPrefetchRoute';

/** `skip`: the route's flag is on, so the page skipped its prefetches and rendered its loading shell. `full`: it is off. */
export type SsrPrefetchCohort = 'skip' | 'full';

export function isSsrPrefetchCohort(value: unknown): value is SsrPrefetchCohort {
  return value === 'skip' || value === 'full';
}
