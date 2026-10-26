import pLimit from 'p-limit';

/**
 * How long a caller waits for the image-cache service to answer when it needs the result: a
 * retraction, or a purge the CDN purge must follow. The service finishes a retraction even when the
 * caller gives up, so a shorter wait does not shorten the work, it only hides how much is running.
 */
export const IMAGE_CACHER_WAIT_MS = 70_000;

export const MAX_IN_FLIGHT_RETRACTIONS = 5;

/**
 * 🔴 Every retraction request this process sends goes through this one limit, whichever path sends
 * it. It is per process: N processes running retraction work can have N × the limit in flight.
 * Take it around a single request only, never around work that may itself take it, or it deadlocks.
 */
export const retractionLimit = pLimit(MAX_IN_FLIGHT_RETRACTIONS);

/**
 * - `confirmed`: the service answered 2xx.
 * - `busy`: the service answered 429 and did nothing, or a 429 earlier in the same run stopped this
 *   one being sent. Try again on a later run.
 * - `unconfirmed`: anything else: another status, a network error, the wait ran out, or not sent.
 */
export type ImageCacherOutcome = 'confirmed' | 'busy' | 'unconfirmed';

/**
 * One per run (or bulk call). The first 429 sets it, and no retraction starts after that: the service
 * is at its limit, and more requests now only add to the load it is shedding.
 */
export type RetractionGate = { busy: boolean };

export const newRetractionGate = (): RetractionGate => ({ busy: false });
