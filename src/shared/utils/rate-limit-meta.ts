/**
 * Machine-readable retry metadata attached to a rate-limit refusal, so a caller can render
 * the wait instead of parsing it out of the prose message. Travels as `data.rateLimit` on a
 * tRPC error, `rateLimit` on a REST error body, and `rateLimit` on a host bridge reply. Its
 * presence marks the refusal as rate-limited; the status lives in the surrounding error.
 */
export type RateLimitMeta = {
  retryAfterSeconds: number;
  /** ISO-8601 instant at which the window resets. */
  retryAt: string;
};

/**
 * Validates metadata that arrived over the network (the host reading `TRPCClientError.data`).
 * Returns a copy holding only the known fields, or `undefined` when `value` is malformed.
 */
export function parseRateLimitMeta(value: unknown): RateLimitMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { retryAfterSeconds, retryAt } = value as Record<string, unknown>;
  if (typeof retryAfterSeconds !== 'number' || !Number.isInteger(retryAfterSeconds))
    return undefined;
  if (retryAfterSeconds < 1) return undefined;
  if (typeof retryAt !== 'string' || Number.isNaN(Date.parse(retryAt))) return undefined;
  return { retryAfterSeconds, retryAt };
}
