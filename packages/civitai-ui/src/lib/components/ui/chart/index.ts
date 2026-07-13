// Charting primitive (C1) — a thin in-house wrapper over Chart.js (the library the main app already
// standardizes on), so the spoke gets a clean-building, consistent charting story. `Chart` manages the
// Chart.js lifecycle and is SSR-safe; chartColor()/chartColors() resolve the theme's `--chart-*` palette for
// series colours (Chart.js can't read CSS variables off a canvas).
export { default as Chart } from './chart.svelte';
export { chartColor, chartColors } from './chart-colors.js';
