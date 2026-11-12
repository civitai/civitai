/** What {@link settleWithin} saw: the value, or that the call failed or ran out of time. */
export type Settled<T> = { ok: true; value: T } | { ok: false; reason: 'error' | 'timeout' };

/**
 * Settle `work` or give up after `ms`, never throwing. For a best-effort dependency call whose failure the
 * caller routes around. The abandoned call carries on in the background; its late rejection is handled.
 */
export async function settleWithin<T>(work: () => Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
  });
  const settled = Promise.resolve()
    .then(work)
    .then(
      (value): Settled<T> => ({ ok: true, value }),
      (): Settled<T> => ({ ok: false, reason: 'error' })
    );
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
