// Bound an awaited promise with a timeout that FALLS SOFT instead of hanging.
//
// A try/catch cannot catch a hang — awaiting a parked promise blocks until the underlying client's own
// default fires, which for @clickhouse/client is 30s. Mirrors withTimeoutFallback in the main app
// (src/server/utils/timeout-helpers.ts); kept separate because this app shares no server code with it.
export async function withTimeoutFallback<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  if (!(ms > 0)) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });

  // A rejection AFTER the timeout has already won has nothing awaiting it; swallow it here or it
  // surfaces as an unhandled rejection.
  promise.catch(() => undefined);

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
