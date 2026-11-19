/**
 * Machine-readable retry metadata attached to a rate-limit refusal, so a caller can render
 * the wait instead of parsing it out of the prose message. Travels as `data.rateLimit` on a
 * tRPC error, `rateLimit` on a REST error body, and `rateLimit` on a host bridge reply. Its
 * presence marks the refusal as rate-limited; the status lives in the surrounding error.
 */
export type RateLimitMeta = {
  retryAfterSeconds: number;
  /** ISO-8601 instant at which this action may be tried again. */
  retryAt: string;
  /** Stable id of the refusing limit, e.g. `posts.daily`. */
  id?: string;
  kind?: RateLimitKind;
  /** The fields below are sent for product limits only, never for abuse limits. */
  limit?: number;
  /** Attempts in the window; can exceed `limit`. */
  used?: number;
  remaining?: number;
  windowSeconds?: number;
  /** ISO-8601 instant at which the whole window is clear. */
  resetAt?: string;
};

/** `product`: an allowance the user may see and buy more of. `abuse`: numbers never published. */
export type RateLimitKind = 'product' | 'abuse';

const COUNT_FIELDS = ['limit', 'used', 'remaining', 'windowSeconds'] as const;

const isIsoInstant = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

/**
 * Validates metadata that arrived over the network (the host reading `TRPCClientError.data`).
 * Returns a copy holding only the known fields, or `undefined` when a required field is
 * malformed. A malformed optional field is dropped on its own.
 */
export function parseRateLimitMeta(value: unknown): RateLimitMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const { retryAfterSeconds, retryAt } = raw;
  if (typeof retryAfterSeconds !== 'number' || !Number.isInteger(retryAfterSeconds))
    return undefined;
  if (retryAfterSeconds < 1) return undefined;
  if (!isIsoInstant(retryAt)) return undefined;

  const meta: RateLimitMeta = { retryAfterSeconds, retryAt };
  if (typeof raw.id === 'string' && raw.id) meta.id = raw.id;
  if (raw.kind === 'product' || raw.kind === 'abuse') meta.kind = raw.kind;
  for (const field of COUNT_FIELDS) {
    const count = raw[field];
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) meta[field] = count;
  }
  if (isIsoInstant(raw.resetAt)) meta.resetAt = raw.resetAt;
  return meta;
}
