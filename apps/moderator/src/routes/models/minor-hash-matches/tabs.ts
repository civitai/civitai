// A sibling module because `+page.server.ts` may only export SvelteKit's own names — exporting this
// from there is a 500 on every request to the route, not a build error.
export const TABS = [
  { value: 'pending', label: 'Pending review' },
  { value: 'auto', label: 'Auto-flagged' },
  { value: 'appeals', label: 'Appeals' },
] as const;

export type MinorQueueTab = (typeof TABS)[number]['value'];
