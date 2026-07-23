// Shared date-range model for the analytics/earnings selectors. A range is an inclusive `[from, to]` pair of ISO
// 'YYYY-MM-DD' strings, carried in the URL as ?from=&to=. Client-safe (pure date math) so both the pages and the
// server reads (cache key + TTL) use the same helpers.

export type DateRange = { from: string; to: string };

// Short presets only; historical periods are chosen via the month picker (which gives a natural month-over-month
// comparison, rather than a 90-day window that predates most accounts' earning history).
export const RANGE_PRESETS = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
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

/** The equally-sized range immediately before `r` — e.g. the prior 30 days, for period-over-period comparison. */
export function previousRange(r: DateRange): DateRange {
  const span = rangeSpanDays(r);
  const from = new Date(`${r.from}T00:00:00Z`);
  return { from: iso(addDays(from, -span)), to: iso(addDays(from, -1)) };
}

/** Shift an ISO 'YYYY-MM-DD' by `days` (negative = earlier) — used to line a prior-period value up under the
 *  current date it should compare against. */
export function shiftIso(isoDate: string, days: number): string {
  return iso(addDays(new Date(`${isoDate}T00:00:00Z`), days));
}

/** Every calendar day in an inclusive range as ISO 'YYYY-MM-DD' — the full x-axis for a chart, so a partial current
 *  month still renders the whole month (the series line just stops where the data does). */
export function eachDayIso(range: DateRange): string[] {
  const out: string[] = [];
  let d = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  while (d <= end) {
    out.push(iso(d));
    d = addDays(d, 1);
  }
  return out;
}

/** Signed day offset from `a` to `b` (b − a), for lining a comparison period's days up under the current ones.
 *  Generalizes the fixed "one period back" shift: the overlay's day at index i sits under the current day at index i,
 *  whatever the comparison period's actual calendar position or length. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const cmpMonthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export type CompareBaseline = { key: string; label: string; range: DateRange };

/** The calendar month containing today. The earnings + analytics pages are month-primary: the whole app compares
 *  one calendar month against an earlier one, matching the monthly Creator-Program settlement model. */
export function currentMonthRange(today = new Date()): DateRange {
  return monthRange(today.getUTCFullYear(), today.getUTCMonth());
}

/** Parse ?from&to into a **calendar-month** range — snapping to the month that contains `from`, so even a stale
 *  rolling-window URL resolves to a clean month. Falls back to the current month when absent/invalid. */
export function parseMonthRange(fromParam: string | null, _toParam: string | null, today = new Date()): DateRange {
  if (fromParam && ISO_RE.test(fromParam)) {
    const d = new Date(`${fromParam}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return monthRange(d.getUTCFullYear(), d.getUTCMonth());
  }
  return currentMonthRange(today);
}

/** 'YYYY-MM' key of a month range. */
export function monthKey(range: DateRange): string {
  return range.from.slice(0, 7);
}

/** Shift a 'YYYY-MM' key by N months (negative = earlier). */
export function shiftMonthKey(key: string, months: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Full calendar-month range for a 'YYYY-MM' key. */
export function monthKeyToRange(key: string): DateRange {
  const [y, m] = key.split('-').map(Number);
  return monthRange(y, m - 1);
}

/** Resolve the comparison **month** from `?cmp` against the selected (primary) month. The comparison is always a
 *  full calendar month strictly earlier than the selected one — never the selected month itself or a future month.
 *  Defaults to (and clamps a now-invalid choice back to) the immediately-prior month. Pure, so every load + the
 *  RangeSelector resolve it identically. */
export function resolveCompareMonth(cmp: string | null, range: DateRange): CompareBaseline {
  const primaryKey = monthKey(range);
  let key = cmp && /^\d{4}-\d{2}$/.test(cmp) ? cmp : '';
  if (!key || key >= primaryKey) key = shiftMonthKey(primaryKey, -1);
  const [y, m] = key.split('-').map(Number);
  return { key, label: cmpMonthFmt.format(Date.UTC(y, m - 1, 1)), range: monthKeyToRange(key) };
}

/** Percent change of `current` vs `previous`; null when there's no baseline (previous = 0) — "% of zero" is
 *  undefined, so callers show a "new" badge instead. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
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
