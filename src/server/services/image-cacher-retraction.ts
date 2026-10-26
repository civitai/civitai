import pLimit from 'p-limit';

/**
 * How long a caller waits for the image-cache service to answer when it needs the result: a
 * retraction, or a purge the CDN purge must follow. The service finishes a retraction even when the
 * caller gives up, so a shorter wait does not shorten the work, it only hides how much is running.
 */
export const IMAGE_CACHER_WAIT_MS = 70_000;

export const MAX_IN_FLIGHT_RETRACTIONS = 5;

/** The longest a retraction waits for a `retractionLimit` slot before it is held back unsent. */
export const RETRACTION_SLOT_WAIT_MS = 60_000;

/**
 * 🔴 Every retraction request this process sends goes through this one limit, whichever path sends
 * it. It is per process: N processes running retraction work can have N × the limit in flight.
 * Take it around a single request only (`inRetractionSlot`), never around work that may itself take
 * it, or it deadlocks.
 */
const retractionLimit = pLimit(MAX_IN_FLIGHT_RETRACTIONS);

/**
 * - `confirmed`: the service answered 2xx.
 * - `busy`: not done, and must not be resent this run: a 429, a timeout, or held back unsent (the
 *   run's gate was set, or no slot came free in time).
 * - `unconfirmed`: anything else: another status, a network error, or not waited for.
 */
export type ImageCacherOutcome = 'confirmed' | 'busy' | 'unconfirmed';

/**
 * One per run (or bulk call). A 429 or a timeout sets it, and no retraction starts after that: the
 * service is at its limit or slow, and more requests now only add to its load.
 */
export type RetractionGate = { busy: boolean };

export const newRetractionGate = (): RetractionGate => ({ busy: false });

export const HELD_BACK = Symbol('held-back');

/**
 * Runs `send` in a `retractionLimit` slot, or returns `HELD_BACK` without running it when the gate is
 * set by the time the slot comes, or no slot comes within `RETRACTION_SLOT_WAIT_MS`. Once `send` has
 * started it is always awaited, so a request is never left running behind the caller's back.
 */
export async function inRetractionSlot<T>(
  send: () => Promise<T>,
  gate?: RetractionGate
): Promise<T | typeof HELD_BACK> {
  let state: 'queued' | 'started' | 'abandoned' = 'queued';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slotWait = new Promise<typeof HELD_BACK>((resolve) => {
    timer = setTimeout(() => {
      if (state !== 'queued') return;
      state = 'abandoned';
      resolve(HELD_BACK);
    }, RETRACTION_SLOT_WAIT_MS);
  });
  const run = retractionLimit(async (): Promise<T | typeof HELD_BACK> => {
    if (state === 'abandoned') return HELD_BACK;
    clearTimeout(timer);
    if (gate?.busy) {
      state = 'abandoned';
      return HELD_BACK;
    }
    state = 'started';
    return await send();
  });
  try {
    return await Promise.race([run, slotWait]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A retraction call that must not be resent in the same run: each caller leaves it for a later run.
 * Resending a refused, slow or still-running retraction at once only adds to the service's load.
 */
export class RetractionNotDoneError extends Error {}

/** Not sent at all: the run's gate was set, no slot came free in time, or the url claim was lost. */
export class RetractionHeldBackError extends RetractionNotDoneError {
  constructor(message = 'retraction held back unsent') {
    super(message);
    this.name = 'RetractionHeldBackError';
  }
}
