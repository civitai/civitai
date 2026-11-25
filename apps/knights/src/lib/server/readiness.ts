import { getSysRedis } from './redis';
import { within } from './redis-timeout';

/** How long one readiness ping may take before the probe answers not-ready and the next probe retries. */
export const READINESS_PING_TIMEOUT_MS = 500;

export interface Readiness {
  /** True once the system Redis has answered a ping; it then stays true for the life of the process. */
  check(): Promise<boolean>;
}

/**
 * Readiness that latches: not ready until the system Redis has answered one ping, then ready for good, so a
 * later Redis blip never takes a serving pod out of rotation. Concurrent checks share one in-flight ping, and
 * a ping that outlives `timeoutMs` is dropped so the next check sends a fresh one.
 */
export function createReadiness({
  ping,
  timeoutMs = READINESS_PING_TIMEOUT_MS,
}: {
  ping: () => Promise<unknown>;
  timeoutMs?: number;
}): Readiness {
  let ready = false;
  let inFlight: Promise<boolean> | undefined;

  const attempt = async (): Promise<boolean> => {
    const ok = await within(Promise.resolve().then(ping), timeoutMs).then(
      () => true,
      () => false
    );
    if (ok) ready = true;
    return ok;
  };

  return {
    check() {
      if (ready) return Promise.resolve(true);
      inFlight ??= attempt().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

// Builds the system client on first use, so readiness works whether or not the server init ran first.
export const readiness = createReadiness({
  ping: () => (getSysRedis() as unknown as { ping: () => Promise<unknown> }).ping(),
});
