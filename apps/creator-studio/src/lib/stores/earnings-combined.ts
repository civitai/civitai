import { persisted } from '$lib/stores/persisted';

// Whether the /earnings "By source" table collapses buzz currencies into one Total Buzz column (Combined) or keeps
// them split per currency. Split is the default.
export const earningsCombined = persisted<boolean>('earnings-combined', false);
