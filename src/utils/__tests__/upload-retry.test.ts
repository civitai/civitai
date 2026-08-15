import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPartRetryDelay, isTerminalCompleteStatus } from '~/utils/upload-retry';

/**
 * `isTerminalCompleteStatus` is the ONE place both upload clients decide whether a
 * `/api/upload/complete` response may be re-POSTed.
 *
 * 🔴 Why it is tested here rather than only through a client: the predicate was
 * open-coded in `s3-upload.store.ts` and MISSING from `useS3Upload.tsx`, which has no
 * test file at all — so the store's behavioural test could stay green while the hook
 * retried a terminal status 4 times, 200 ms apart. Pinning the shared predicate is what
 * makes the hook's copy of the rule covered, because it no longer has a copy.
 */
describe('isTerminalCompleteStatus', () => {
  it.each([
    // The multipart session is already finalized or aborted.
    [409, true],
    // The upload STATE is bad: an unacceptable parts manifest, or a completion whose
    // object could not be verified. Re-sending the same manifest cannot fix either.
    [422, true],
  ])('treats %i as terminal', (status, expected) => {
    expect(isTerminalCompleteStatus(status)).toBe(expected);
  });

  it.each([
    // Retryable: a genuine transient backend fault.
    [503, false],
    [500, false],
    // Not terminal-by-contract — these must keep their existing retry behaviour rather
    // than being silently swallowed as final.
    [429, false],
    [408, false],
    [401, false],
    [400, false],
    // Success is not "terminal failure"; the callers gate on !res.ok first, but the
    // predicate must not claim a 2xx is terminal if that order ever changes.
    [200, false],
  ])('does not treat %i as terminal', (status, expected) => {
    expect(isTerminalCompleteStatus(status)).toBe(expected);
  });

  // 🔴 An enumerated ledger, not a spot check: if a status is ADDED to or REMOVED from
  // the terminal set, this fails and forces both clients' behaviour to be reconsidered
  // together — which is the whole point of the predicate living in one module.
  it('the terminal set is exactly {409, 422}', () => {
    const terminal = Array.from({ length: 600 }, (_, i) => i)
      .filter((s) => s >= 100)
      .filter(isTerminalCompleteStatus);
    expect(terminal).toEqual([409, 422]);
  });
});

/**
 * The backoff POLICY is only observable through the store as elapsed wall clock, so it had no
 * cover at all: making 429 and 5xx non-retryable left every s3-upload.store test green. Pinned
 * here, where the numbers can be read directly instead of waited for.
 */
describe('getPartRetryDelay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grows exponentially with the attempt, so a struggling backend gets backed off', () => {
    const delays = [0, 1, 2].map((attempt) => getPartRetryDelay({ status: 503 }, attempt));
    // ~1s, 2s, 4s, each plus up to 1s of jitter — asserted as bands, since the jitter is random.
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThan(3000);
    expect(delays[2]).toBeGreaterThanOrEqual(4000);
    expect(delays[2]).toBeLessThan(5000);
  });

  it('caps at a minute however many attempts have gone by', () => {
    // Without a ceiling, attempt 20 is 2^20 seconds — the upload would never resume. The cap is
    // applied to the base and the jitter is added after, so a minute is the floor of the capped
    // value, not a hard ceiling.
    const delay = getPartRetryDelay({ status: 503 }, 20);
    expect(delay).toBeGreaterThanOrEqual(60_000);
    expect(delay).toBeLessThan(61_000);
  });

  it('obeys a numeric Retry-After ahead of its own schedule', () => {
    // The server's number is authoritative: retrying sooner than it asked is what turns a 429
    // into a ban.
    expect(getPartRetryDelay({ status: 429, retryAfter: '30' }, 0)).toBe(30_000);
  });

  it('caps a Retry-After the same way', () => {
    expect(getPartRetryDelay({ status: 429, retryAfter: '3600' }, 0)).toBe(60_000);
  });

  it('reads an HTTP-date Retry-After as a delta from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(getPartRetryDelay({ status: 429, retryAfter: 'Thu, 01 Jan 2026 00:00:20 GMT' }, 0)).toBe(
      20_000
    );
  });

  it('floors a Retry-After date that has already passed, rather than retrying instantly', () => {
    // A skewed client clock can put the server's date in the past; hammering it immediately is
    // the opposite of what the header asked for.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    expect(getPartRetryDelay({ status: 429, retryAfter: 'Thu, 01 Jan 2026 00:00:00 GMT' }, 0)).toBe(
      1000
    );
  });

  it('falls back to the schedule when Retry-After is unparseable', () => {
    const delay = getPartRetryDelay({ status: 429, retryAfter: 'soon' }, 0);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
  });
});
