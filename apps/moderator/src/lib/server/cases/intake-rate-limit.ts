/** Too many requests from one address in the window. */
export class IntakeRateLimitedError extends Error {
  readonly status = 429;
  constructor() {
    super('Too many requests. Try again later, or email us.');
    this.name = 'IntakeRateLimitedError';
  }
}

/**
 * A per-process fixed window per key. Each pod counts on its own, so the real ceiling is the limit times
 * the pod count; the main app keeps its own limit in front, and the per-address receipt cap bounds mail.
 */
export function createIntakeRateLimit({
  limit,
  windowMs,
  now = Date.now,
  maxKeys = 10_000,
}: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}) {
  const hits = new Map<string, { start: number; count: number }>();
  return (key: string) => {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      if (!h && hits.size >= maxKeys)
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      // Still full of live windows: refuse rather than grow without bound.
      if (!h && hits.size >= maxKeys) throw new IntakeRateLimitedError();
      h = { start: t, count: 0 };
      hits.set(key, h);
    }
    if (++h.count > limit) throw new IntakeRateLimitedError();
  };
}
