// Name of the cookie that holds the analytics period (`from|cmp`), written host-only (see CookieState) so it stays
// scoped to creator-studio.civitai.com. Client-safe; the server reader lives in $lib/server/analytics-period.ts.
export const ANALYTICS_PERIOD_COOKIE = 'cs-analytics-period';

export type Period = { from: string; cmp: string };

/** The URL to navigate to after a period pick, with a `?month=` deep link dropped; null when the URL has none and a
 *  plain reload is enough. Without this the param would keep overriding the cookie the pick just wrote. */
export function withoutMonthParam(url: URL): URL | null {
  if (!url.searchParams.has('month')) return null;
  const next = new URL(url);
  next.searchParams.delete('month');
  return next;
}

/** The cookie value after a pick. `current` is what the picker shows, which on a `?month=` deep link is the URL's
 *  month, not the saved one — so picking only the comparison also commits that month to the cookie. A new month keeps
 *  the comparison (the server clamps it if it is no longer earlier than the month). */
export function nextPeriod(current: Period, pick: { month: string } | { cmp: string }): Period {
  return 'month' in pick
    ? { from: pick.month, cmp: current.cmp }
    : { from: current.from, cmp: pick.cmp };
}
