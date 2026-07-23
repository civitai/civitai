// Name of the cookie that holds the analytics period (`from|cmp`), written host-only (see CookieState) so it stays
// scoped to creator.civitai.com. Client-safe; the server reader lives in $lib/server/analytics-period.ts.
export const ANALYTICS_PERIOD_COOKIE = 'cs-analytics-period';
