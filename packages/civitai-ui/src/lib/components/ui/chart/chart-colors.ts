// Bridge the design system's chart palette (`--chart-1..5`, defined in theme.css for light + dark) to concrete
// color strings. Chart.js paints to a <canvas> and can't resolve CSS variables, so we read them off :root at
// runtime. SSR (no document) falls back to fixed values; the client resolves the real themed colors on mount.
const FALLBACKS = ['#4f8cff', '#22c55e', '#f59e0b', '#a855f7', '#ef4444'];

/** Resolved themed color for series `index` (cycles through the 5 `--chart-*` variables). */
export function chartColor(index: number): string {
  const n = (((index % 5) + 5) % 5) + 1; // 1..5, wraps and handles negatives
  if (typeof document === 'undefined') return FALLBACKS[n - 1];
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--chart-${n}`).trim();
  return v || FALLBACKS[n - 1];
}

/** The first `count` themed series colors. */
export function chartColors(count = 5): string[] {
  return Array.from({ length: count }, (_, i) => chartColor(i));
}
