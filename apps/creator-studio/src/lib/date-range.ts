// Shared date-range model for the analytics/earnings selectors. A range is an inclusive `[from, to]` pair of ISO
// 'YYYY-MM-DD' strings, carried in the URL as ?from=&to=. Client-safe (pure date math) so both the pages and the
// server reads (cache key + TTL) use the same helpers.

export type DateRange = { from: string; to: string };

export const RANGE_PRESETS = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
] as const;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

/** Last `days` calendar days ending today (inclusive), e.g. 30d → [today-29, today]. */
export function presetRange(days: number, today = new Date()): DateRange {
  return { from: iso(addDays(today, -(days - 1))), to: iso(today) };
}

/** Calendar month by 0-based month index → [first, last] of that month. */
export function monthRange(year: number, month0: number): DateRange {
  return {
    from: iso(new Date(Date.UTC(year, month0, 1))),
    to: iso(new Date(Date.UTC(year, month0 + 1, 0))),
  };
}

export type MonthOption = { key: string; label: string; range: DateRange };

/** The most recent `n` months (current first) for the month quick-pick. */
export function recentMonths(n: number, today = new Date()): MonthOption[] {
  const out: MonthOption[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    out.push({
      key: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      range: monthRange(y, m),
    });
  }
  return out;
}

/** Inclusive span in days. */
export function rangeSpanDays(r: DateRange): number {
  const from = Date.parse(`${r.from}T00:00:00Z`);
  const to = Date.parse(`${r.to}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/** Cache TTL (seconds) scaled to the range span, capped at 30 min — enough to blunt reload/back-nav bursts
 *  without hoarding: ~5 min for a week, ~20 min for a month, ~30 min for multi-month. */
export function rangeTtlSeconds(r: DateRange): number {
  const span = rangeSpanDays(r);
  if (span >= 60) return 1800;
  if (span >= 25) return 1200;
  return 300;
}

/** Validate ?from=&to= from the URL; fall back to a preset when absent/invalid. */
export function parseRange(
  fromParam: string | null,
  toParam: string | null,
  defaultDays = 30
): DateRange {
  if (
    fromParam &&
    toParam &&
    ISO_RE.test(fromParam) &&
    ISO_RE.test(toParam) &&
    fromParam <= toParam
  ) {
    return { from: fromParam, to: toParam };
  }
  return presetRange(defaultDays);
}

/** True when the range exactly matches a "last N days" preset (for highlighting the preset buttons). */
export function matchesPreset(r: DateRange, days: number, today = new Date()): boolean {
  const p = presetRange(days, today);
  return p.from === r.from && p.to === r.to;
}

const df = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
/** Human label for a range, e.g. "Jul 1 – Jul 31, 2026". */
export function formatRange(r: DateRange): string {
  return `${df.format(Date.parse(`${r.from}T00:00:00Z`))} – ${df.format(
    Date.parse(`${r.to}T00:00:00Z`)
  )}`;
}
