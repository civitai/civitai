import { LocalState } from '$lib/state/local-state.svelte';

// Whether the /earnings "By source" table collapses buzz currencies into one Total Buzz column (Combined) or keeps
// them split per currency. Split is the default.
export const earningsCombined = new LocalState<boolean>('earnings-combined', false);
