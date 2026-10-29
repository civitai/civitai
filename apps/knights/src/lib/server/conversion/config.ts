/** Starting values; tune against real conversion history. */
export const CONVERSION = {
  /** Gold per Yellow Buzz. Only whole Buzz are paid, so the remainder stays convertible. */
  goldPerBuzz: 1000,
  /** The least Buzz one conversion pays out. */
  minBuzz: 5,
} as const;

/** A conversion that Buzz did not confirm is retried once it is this old. */
export const PENDING_CONVERSION_RETRY_AFTER_MS = 60_000;
