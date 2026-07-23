import { LocalState } from '$lib/state/local-state.svelte';

// Shared rows-per-page preference for the client-paginated analytics tables (models, engagement, base models).
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const analyticsPageSize = new LocalState<number>('analytics-page-size', 25);
