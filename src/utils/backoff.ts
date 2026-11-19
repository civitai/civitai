export type BackoffOptions = {
  /** The delay for attempt 0; it doubles with each attempt. */
  baseMs: number;
  /** Ceiling on the doubled delay. */
  maxMs?: number;
  /** Up to this much random delay added on top, after the ceiling. */
  jitterMs?: number;
};

/**
 * Exponential backoff: `min(maxMs, baseMs * 2^attempt) + random() * jitterMs`. `attempt` counts
 * from 0; a negative one shrinks the delay rather than clamping to `baseMs`.
 */
export function backoffDelay(
  attempt: number,
  { baseMs, maxMs = Infinity, jitterMs = 0 }: BackoffOptions
) {
  // Caps the exponent: 2 ** attempt reaches Infinity past 1023, and so would the delay when maxMs is unset.
  const delay = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return jitterMs ? delay + Math.random() * jitterMs : delay;
}
