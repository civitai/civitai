export const CONVERSION = {
  goldPerBuzz: 1000,
  minBuzz: 5,
} as const;

export const PENDING_CONVERSION_RETRY_AFTER_MS = 60_000;

/** One tick retries at most this many unconfirmed conversions, and stops starting new ones after the budget. */
export const TICK_CONVERSION_RETRY = { limit: 20, budgetMs: 20_000 } as const;
