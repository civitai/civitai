// The single-budget Buzz spend limit the UIs offer, and its mapping to the stored budgets array
// (`ApiKey.buzzLimit` / `OauthConsent.buzzLimit`, validated by `buzzLimitSchema` in the main app's
// src/server/schema/api-key.schema.ts). Shared so the main app's limit editors and the auth hub's
// consent screen write the same shape.

/** The UI's simple limit: `limit` Buzz per rolling `period`. */
export type SimpleBuzzLimit = {
  limit: number;
  period: 'day' | 'week' | 'month';
};

export const SIMPLE_BUZZ_LIMIT_PERIODS = ['day', 'week', 'month'] as const;

const PERIOD_DAYS: Record<SimpleBuzzLimit['period'], number> = {
  day: 1,
  week: 7,
  month: 30,
};

/** The one budget a simple limit stores as. */
export type SimpleSlidingBudget = {
  type: 'sliding';
  limit: number;
  window: 'day';
  unit: number;
};

/** The fields of a stored budget `budgetsToSimpleBuzzLimit` reads. */
type StoredBudget = {
  type: string;
  limit: number;
  currencies?: string[];
  window?: string;
  unit?: number;
};

/**
 * Convert the UI's simple {limit, period} form into the canonical budgets array: one `sliding`
 * budget with the period collapsed onto a `day` window.
 */
export function simpleBuzzLimitToBudgets(
  simple: SimpleBuzzLimit | null
): SimpleSlidingBudget[] | null {
  if (!simple) return null;
  return [
    { type: 'sliding', limit: simple.limit, window: 'day', unit: PERIOD_DAYS[simple.period] },
  ];
}

/**
 * Reverse mapping. Returns the simple representation if and only if the budgets array is exactly
 * one currency-unscoped sliding budget that matches one of the simple periods. Otherwise null
 * (treat as either "no limit" or "custom" depending on caller).
 */
export function budgetsToSimpleBuzzLimit(
  budgets: readonly StoredBudget[] | null | undefined
): SimpleBuzzLimit | null {
  if (!budgets || budgets.length !== 1) return null;
  const b = budgets[0];
  if (b.type !== 'sliding') return null;
  if (b.currencies && b.currencies.length > 0) return null;

  if (b.window === 'day' && b.unit === 1) return { limit: b.limit, period: 'day' };
  if (b.window === 'day' && b.unit === 7) return { limit: b.limit, period: 'week' };
  if (b.window === 'day' && b.unit === 30) return { limit: b.limit, period: 'month' };
  if (b.window === 'week' && b.unit === 1) return { limit: b.limit, period: 'week' };
  if (b.window === 'month' && b.unit === 1) return { limit: b.limit, period: 'month' };
  return null;
}
