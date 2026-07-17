// Client-safe presentation vocabulary for earnings — no server deps, so the server read module
// ($lib/server/earnings) and the pages both import the source/currency definitions from here.

export const EARNINGS_SOURCES = [
  'compensation',
  'tip',
  'licenseFee',
  'accessSale',
  'cosmeticSale',
] as const;
export type EarningsSource = (typeof EARNINGS_SOURCES)[number];

export const SOURCE_LABEL: Record<EarningsSource, string> = {
  compensation: 'Generation compensation',
  tip: 'Tips',
  licenseFee: 'License fees',
  accessSale: 'Access sales',
  cosmeticSale: 'Cosmetic sales',
};

// Per-source line colors for the earnings trend chart (distinct hues; not the buzz-currency palette).
export const SOURCE_COLOR: Record<EarningsSource, string> = {
  compensation: '#4dabf7',
  tip: '#f59f00',
  licenseFee: '#40c057',
  accessSale: '#9775fa',
  cosmeticSale: '#f783ac',
};

// Currencies are the raw `toAccountType` values, never converted or merged (B8 / D1). `family` only drives visual
// grouping/formatting (⚡ for buzz), never summing across families.
export type CurrencyFamily = 'buzz' | 'cash' | 'bank';
export type CurrencyMeta = { label: string; family: CurrencyFamily; order: number; color: string };

// `color` mirrors the main app's buzz palette (src/shared/constants/currency.constants.ts) so charts/legends read
// as the real buzz colors — yellow #f59f00, blue #4dabf7, green #40c057.
const CURRENCY_META: Record<string, CurrencyMeta> = {
  yellow: { label: 'Yellow Buzz', family: 'buzz', order: 1, color: '#f59f00' },
  blue: { label: 'Blue Buzz', family: 'buzz', order: 2, color: '#4dabf7' },
  green: { label: 'Green Buzz', family: 'buzz', order: 3, color: '#40c057' },
  club: { label: 'Club Buzz', family: 'buzz', order: 4, color: '#9775fa' },
  cashSettled: { label: 'Cash · settled', family: 'cash', order: 5, color: '#12b886' },
  cashPending: { label: 'Cash · pending', family: 'cash', order: 6, color: '#63e6be' },
  creatorProgramBank: { label: 'Banked Buzz', family: 'bank', order: 7, color: '#f59f00' },
  creatorProgramBankGreen: {
    label: 'Banked Buzz · green',
    family: 'bank',
    order: 8,
    color: '#40c057',
  },
};

export function currencyMeta(currency: string): CurrencyMeta {
  return (
    CURRENCY_META[currency] ?? { label: currency, family: 'buzz', order: 99, color: '#868e96' }
  );
}

// Order currencies for stable display: by family/known order, then name.
export function currencySort(a: string, b: string): number {
  return currencyMeta(a).order - currencyMeta(b).order || a.localeCompare(b);
}

const nf = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// Cash accounts (cashSettled/cashPending) hold their balance in USD **cents**, not buzz — so USD = cents / 100,
// matching the main app's `formatCurrencyForDisplay` (value / 100). (Do NOT use buzzDollarRatio here; that's for
// converting spendable buzz, a different thing.)
export const CASH_CENTS_PER_USD = 100;
export const centsToUsd = (cents: number) => cents / CASH_CENTS_PER_USD;

// Buzz is a whole-unit currency — the underlying compensation amounts are fractional (Float64), but we never show
// partial buzz, so floor before formatting. (Cash is real USD cents and keeps its precision.)
export function formatBuzz(amount: number): string {
  return `⚡ ${nf.format(Math.floor(amount))}`;
}

// Whether an amount is worth showing at all: buzz under 1 floors to 0, so it renders as nothing (`—`) rather than
// a misleading `⚡ 0`. Cash keeps its cents, so any positive cash is displayable.
export function hasDisplayValue(amount: number, currency: string): boolean {
  return currencyMeta(currency).family === 'cash' ? amount > 0 : Math.floor(amount) >= 1;
}

// Buzz + banked balances show a ⚡ with the (floored) buzz count; cash (settled/pending) is USD-cents → shown as $.
// Never mix families in one total — callers only ever format a single-currency amount.
export function formatAmount(amount: number, currency: string): string {
  const { family } = currencyMeta(currency);
  return family === 'cash' ? usd.format(centsToUsd(amount)) : formatBuzz(amount);
}
