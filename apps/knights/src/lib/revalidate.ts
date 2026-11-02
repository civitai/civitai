const abortable = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

const wait = (ms: number, signal: AbortSignal) =>
  Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms)), abortable(signal)]);

/**
 * Re-asks the server until `signal` aborts, one request at a time. Overlapping `invalidate` calls cancel each other, so a
 * load slower than the interval would never finish; this waits for each to settle, then pauses `delays[attempt]` (the last
 * one repeats). A failed attempt is retried like a stale answer.
 */
export async function revalidateUntilStopped(
  revalidate: () => Promise<unknown>,
  {
    signal,
    delays = [500, 1000, 2000, 3000],
    sleep = wait,
  }: {
    signal: AbortSignal;
    delays?: number[];
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  }
): Promise<void> {
  for (let attempt = 0; !signal.aborted; attempt++) {
    await Promise.race([revalidate().catch(() => undefined), abortable(signal)]);
    if (signal.aborted) return;
    await sleep(delays[Math.min(attempt, delays.length - 1)], signal);
  }
}
