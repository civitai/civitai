/** Rotating items on sale at once, and deals per day. Prices are data (`KnightsShopItem`); these two shape the day. */
export const ROTATION_SIZE = 4;
export const DEALS_PER_DAY = 2;
/** Percent off a deal's list price. */
export const DEAL_PERCENT = 20;

/** The main app grants membership in 30-day chunks (`grantReferralSubscription`). */
export const MEMBERSHIP_DAYS_PER_MONTH = 30;

/** The longest one request to the main app may take. */
export const MAIN_APP_TIMEOUT_MS = 8_000;

export const PENDING_PURCHASE_RETRY_AFTER_MS = 60_000;

/** One tick retries at most `limit` unconfirmed purchases, and starts none that could not finish inside the budget. */
export const TICK_PURCHASE_RETRY = {
  limit: 20,
  budgetMs: 20_000,
  attemptMs: MAIN_APP_TIMEOUT_MS,
} as const;
