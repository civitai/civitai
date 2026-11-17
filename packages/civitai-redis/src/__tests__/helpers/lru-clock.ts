/**
 * For tests that mock `performance.now` to drive an L1 (lru-cache) TTL.
 *
 * lru-cache does not read the clock on every call: it keeps one reading and clears it on a 1ms
 * timer (its `ttlResolution`). After moving a mocked clock, a test must let that timer fire, or the
 * next read reuses the reading from before the move. That applies after an `advance` within a case,
 * and before each case: a case with no `advance` never yields to the timer, so a reading left by the
 * previous case (later than this case's restarted clock) would age every entry it writes.
 *
 * Await this after every change to the mocked clock.
 */
export const letLruClockClear = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
