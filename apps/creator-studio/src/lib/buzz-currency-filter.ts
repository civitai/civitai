// Which buzz account types the /analytics/models earnings columns count. Client-safe; the server reader
// lives in $lib/server/buzz-currency-filter.ts.
//
// Written host-only (see CookieState) so it stays scoped to creator-studio.civitai.com.
export const BUZZ_CURRENCY_COOKIE = 'cs-buzz-currencies';

export const FILTERABLE_CURRENCIES = ['yellow', 'green', 'blue'] as const;
export type FilterableCurrency = (typeof FILTERABLE_CURRENCIES)[number];

// Mirrors `bankable` in the main app's buzzTypeConfig: yellow and green can be banked and withdrawn,
// blue cannot. Summing all three gives a number a creator has to mentally correct before it means
// anything, so the default total is the withdrawable pair and blue is opted into.
export const BANKABLE_CURRENCIES = [
  'yellow',
  'green',
] as const satisfies readonly FilterableCurrency[];

const isFilterable = (v: string): v is FilterableCurrency =>
  (FILTERABLE_CURRENCIES as readonly string[]).includes(v);

/**
 * Parse the cookie (comma-separated account types) into the selected currencies.
 *
 * Absent, unparseable, or empty all fall back to the bankable pair rather than to nothing — a control
 * that can zero every earnings column reads as broken data, not as a filter.
 */
export function parseCurrencyFilter(raw: string | null | undefined): FilterableCurrency[] {
  const picked = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isFilterable);
  return picked.length
    ? FILTERABLE_CURRENCIES.filter((c) => picked.includes(c))
    : [...BANKABLE_CURRENCIES];
}

export const encodeCurrencyFilter = (values: readonly FilterableCurrency[]): string =>
  (values.length ? values : BANKABLE_CURRENCIES).join(',');

/** Label for the current selection, e.g. "Withdrawable buzz" / "Yellow Buzz only". */
export function currencySelectionKind(
  selected: readonly FilterableCurrency[]
): 'bankable' | 'all' | 'custom' {
  if (selected.length === FILTERABLE_CURRENCIES.length) return 'all';
  if (
    selected.length === BANKABLE_CURRENCIES.length &&
    BANKABLE_CURRENCIES.every((c) => selected.includes(c))
  )
    return 'bankable';
  return 'custom';
}
