/** The shape of a buyer's idempotency key. */
export const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

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
