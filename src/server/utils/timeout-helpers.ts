// Bound an awaited promise with a timeout that FALLS SOFT instead of hanging.
//
// A try/catch cannot catch a hang — an `await` on a parked promise just blocks
// until whatever the underlying client's own (often very long) default timeout
// fires. `withTimeoutFallback` races the work against a timer: if the timer wins,
// we resolve with `fallback` (and optionally call `onTimeout`) so the CALLER
// unblocks even though the underlying operation may keep running server-side.
//
// We can't abort the underlying work here, so we attach a no-op `.catch` to the
// racing promise to avoid an unhandled rejection if it later rejects after we've
// already resolved with the fallback. The timer is cleared on the happy path.
export async function withTimeoutFallback<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void
): Promise<T> {
  if (!(ms > 0)) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });

  // If `promise` rejects AFTER the timeout already won, nothing is awaiting it →
  // swallow that to prevent an unhandled rejection. (On the happy path the race
  // resolves with the real value and this guard never fires.)
  promise.catch(() => {});

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
