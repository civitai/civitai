import { writable } from 'svelte/store';
import { browser } from '$app/environment';

// User's line/bar preference for time-series charts, persisted so it survives navigation + sessions. In bar mode the
// current-period series renders as bars; any comparison/previous overlay stays a line (pinned per-dataset).
export type ChartType = 'line' | 'bar';
const KEY = 'cs-chart-type';

export const chartType = writable<ChartType>(
  browser && localStorage.getItem(KEY) === 'bar' ? 'bar' : 'line'
);

if (browser) {
  chartType.subscribe((v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode / storage disabled — preference just won't persist */
    }
  });
}
