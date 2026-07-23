import { LocalState } from '$lib/state/local-state.svelte';

// User's line/bar preference for time-series charts, persisted so it survives navigation + sessions. In bar mode the
// current-period series renders as bars; any comparison/previous overlay stays a line (pinned per-dataset).
export type ChartType = 'line' | 'bar';

export const chartType = new LocalState<ChartType>('chart-type', 'line');
