export const ROTATION_SIZE = 4;
export const DEALS_PER_DAY = 2;
export const DEAL_PERCENT = 20;

export const MAIN_APP_TIMEOUT_MS = 8_000;

export const PENDING_PURCHASE_RETRY_AFTER_MS = 60_000;

/** A membership purchase still unconfirmed after this many tries is logged as an error, and again every this many tries. */
export const PENDING_PURCHASE_ALERT_ATTEMPTS = 30;

/** One tick retries at most `limit` unconfirmed purchases, and starts none that could not finish inside the budget. */
export const TICK_PURCHASE_RETRY = {
  limit: 20,
  budgetMs: 20_000,
  attemptMs: MAIN_APP_TIMEOUT_MS,
} as const;
