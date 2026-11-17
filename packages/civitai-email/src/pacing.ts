/**
 * SES's sending rate is account-wide: a faster bulk run gets throttled and takes the rest of the
 * site's email down with it.
 */
export const NOTICE_MIN_INTERVAL_MS = 500;
export const THROTTLE_RETRY_DELAYS_MS = [2_000, 5_000];

export type Sleep = (ms: number) => Promise<unknown>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SES answers an over-rate send with SMTP 454 "Throttling failure: Maximum sending rate exceeded". */
export function isThrottlingError(e: unknown) {
  const err = e as { responseCode?: number; message?: string } | null;
  return err?.responseCode === 454 || /throttling/i.test(err?.message ?? '');
}

/**
 * Only wrap the email step: a retry re-runs `fn` in full, so it must not repeat whatever the send
 * did before it.
 */
export async function withThrottleRetry<T>(
  fn: () => Promise<T>,
  {
    delaysMs = THROTTLE_RETRY_DELAYS_MS,
    sleep = realSleep,
  }: { delaysMs?: number[]; sleep?: Sleep } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length || !isThrottlingError(e)) throw e;
      await sleep(delaysMs[attempt]);
    }
  }
}
