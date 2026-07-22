import { persisted } from '$lib/stores/persisted';

// User's line/bar preference for time-series charts, persisted so it survives navigation + sessions. In bar mode the
// current-period series renders as bars; any comparison/previous overlay stays a line (pinned per-dataset).
export type ChartType = 'line' | 'bar';

export const chartType = persisted<ChartType>('chart-type', 'line');
