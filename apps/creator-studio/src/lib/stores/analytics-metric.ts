import { LocalState } from '$lib/state/local-state.svelte';

// Which usage metric the analytics time-series charts plot. Shared across the base-models and per-model
// charts so the choice carries between them instead of resetting per page.
export type AnalyticsMetric = 'generations' | 'downloads';

export const analyticsMetric = new LocalState<AnalyticsMetric>('analytics-metric', 'generations');
