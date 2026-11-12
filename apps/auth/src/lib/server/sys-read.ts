// A deadline for the hub's best-effort sys-redis calls on the request path (revocation, family liveness,
// the permissions map). Every caller already fails open on an error; this makes a HUNG sys redis an error
// too, instead of a request that waits for the client's own 30 s backstop.
//
// Once one call times out, the next calls in the following SYS_READ_TRIP_MS fail at once rather than each
// waiting out its own deadline: one identity request makes several of these calls in sequence, and only
// the first should pay for the outage. The first call after the window probes again.

/** Same as the main app's REDIS_SYS_READ_TIMEOUT_MS default and createRevocationCheck's. */
export const SYS_READ_DEADLINE_MS = 2_000;
export const SYS_READ_TRIP_MS = 5_000;

let trippedUntil = 0;

export class SysReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SysReadUnavailableError';
  }
}

/**
 * Settle `work()`, or reject after SYS_READ_DEADLINE_MS (or at once while tripped). The abandoned call
 * carries on in the background; its late rejection is handled.
 */
export async function withSysReadDeadline<T>(work: () => Promise<T>): Promise<T> {
  if (Date.now() < trippedUntil) {
    throw new SysReadUnavailableError('sys redis skipped after a recent timeout');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      trippedUntil = Date.now() + SYS_READ_TRIP_MS;
      reject(
        new SysReadUnavailableError(`sys redis call timed out after ${SYS_READ_DEADLINE_MS}ms`)
      );
    }, SYS_READ_DEADLINE_MS);
  });
  const call = Promise.resolve().then(work);
  call.catch(() => undefined);
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget a trip left by an earlier case. */
export function resetSysReadTrip(): void {
  trippedUntil = 0;
}
