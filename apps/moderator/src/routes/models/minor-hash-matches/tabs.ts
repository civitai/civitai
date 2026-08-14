/** The page's own path, shared with the two `/api/*` endpoints that gate on it. `/api/*` is exempt
 *  from the global route guard, so each one re-checks access itself — and when this page moved under
 *  `/models`, the copy in the detail endpoint was left behind and 403'd every expand while the counts
 *  beside it kept working. One export so the next move cannot half-land. */
export const MINOR_HASH_PATH = '/models/minor-hash-matches';

// A sibling module because `+page.server.ts` may only export SvelteKit's own names — exporting this
// from there is a 500 on every request to the route, not a build error.
export const TABS = [
  { value: 'pending', label: 'Pending review' },
  { value: 'auto', label: 'Auto-flagged' },
  { value: 'appeals', label: 'Appeals' },
] as const;

export type MinorQueueTab = (typeof TABS)[number]['value'];
