/** Settles with `work`, or as soon as `signal` aborts; the abort listener never outlives the race. */
function untilAborted(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work.then(() => undefined), aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort)
  );
}

const wait = (ms: number, signal: AbortSignal) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return untilAborted(
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
    signal
  ).finally(() => clearTimeout(timer));
};

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
    await untilAborted(
      revalidate().catch(() => undefined),
      signal
    );
    if (signal.aborted) return;
    await sleep(delays[Math.min(attempt, delays.length - 1)], signal);
  }
}
