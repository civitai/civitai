export const CONVERSION = {
  goldPerBuzz: 1000,
  minBuzz: 5,
} as const;

export const PENDING_CONVERSION_RETRY_AFTER_MS = 60_000;

/** The longest one Buzz write may take. */
export const BUZZ_WRITE_TIMEOUT_MS = 15_000;

/** One tick retries at most `limit` unconfirmed conversions, and starts none that could not finish inside the budget. */
export const TICK_CONVERSION_RETRY = {
  limit: 20,
  budgetMs: 30_000,
  attemptMs: BUZZ_WRITE_TIMEOUT_MS,
} as const;
