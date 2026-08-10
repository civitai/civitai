import { describe, expect, it } from 'vitest';
import { isTerminalCompleteStatus } from '~/utils/upload-retry';

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
