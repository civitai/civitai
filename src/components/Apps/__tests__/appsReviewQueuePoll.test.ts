import { describe, expect, test, vi } from 'vitest';

/**
 * `/apps/review` PENDING QUEUE — the pure poll-interval decision.
 *
 * The Pending tab auto-refreshes so a moderator sees new submissions without reloading
 * the page. That poll has to stop dead in exactly ONE state: a CURSOR means the mod has
 * paged past page 1, at which point the page-1 query is unmounted and its accumulated rows
 * are frozen React state — a poll would refresh only the last-loaded page and leave the
 * rest silently stale, which looks live and is not.
 *
 * ⚠️ AN `hasError` INPUT WAS DELETED FROM THIS PREDICATE, AND THE DELETION IS THE POINT.
 * It parked the poll on any query error, which under the repo-wide `staleTime: Infinity`
 * was a PERMANENT park with no automatic route back — so the page grew a status row and a
 * Refresh button purely to undo it. Dropping the input restores self-healing (the next tick
 * retries) and took the whole cascade with it. Do not reintroduce it; the page-level
 * consequence is pinned in `src/tests/pages/apps/review/review-queue-poll.browser.test.tsx`.
 *
 * The decision is exported as a pure function for exactly this reason: the house pattern
 * set by `computeAgentReviewPollInterval` + `agentReviewPoll.test.ts`, one directory over.
 *
 * 🔴 WHY THE MOCKS BELOW. The helper lives in the PAGE module, which also declares
 * `getServerSideProps` and therefore imports the tRPC server graph at module top level.
 * The page's own SSR-gate suites (`src/tests/pages/apps/review/*-gate.test.ts`) stub the
 * same seam for the same reason. Nothing mocked here is under test — the unit is a pure
 * function of its argument — and the two exports are read from the REAL module, so a
 * deleted or renamed helper fails to import rather than passing vacuously.
 */

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

const { APPS_REVIEW_POLL_MS, computeReviewQueuePollInterval } = await import('~/pages/apps/review');

describe('computeReviewQueuePollInterval', () => {
  test('no cursor (the default live view) → polls at APPS_REVIEW_POLL_MS', () => {
    expect(computeReviewQueuePollInterval({ hasCursor: false })).toBe(APPS_REVIEW_POLL_MS);
  });

  test('a CURSOR parks the poll → false', () => {
    expect(computeReviewQueuePollInterval({ hasCursor: true })).toBe(false);
  });

  /**
   * ⚠️ SEVERAL MORE TESTS WERE DELETED FROM HERE RATHER THAN KEPT, AND THE DELETIONS ARE
   * THE POINT — this file's domain is now ONE boolean, and the two tests above pin both of
   * its points to an exact value with `toBe`, so a great many plausible-looking extra
   * assertions cannot fail while those pass.
   *
   * Three went with the `hasError` input itself (error-parks, and the two combinations
   * involving it). A fourth asserted `APPS_REVIEW_POLL_MS` equalled the literal `15_000`
   * while its title claimed a coupling to `QUEUE_POLL_MS` in
   * `src/pages/moderator/resource-load.tsx` — a coupling the constant's own docblock
   * explicitly disclaims as unenforceable (that constant is module-local and unexported).
   * Stripped of the false claim it was a literal asserted against a literal in the same
   * module, which no mutation of the production code can fail.
   *
   * Two older ones were deleted before that. The first asserted `typeof got === 'number'`
   * and `got > 0` on the polling branch. The second looped the parked inputs re-asserting
   * `toBe(false)` plus `typeof === 'boolean'` — a strict duplicate, with an inner assertion
   * that could not fail while the `toBe(false)` on the line above it passed. Its title
   * claimed it was defending against a falsy `0`, and `toBe` is `Object.is`, so the
   * surviving tests already reject `0`.
   *
   * ⚠️ That title also stated a mechanism that is simply not true of the installed
   * version: `0` does NOT mean "as fast as possible". `#updateRefetchInterval`
   * (query-core 5.101.0 `queryObserver.js:211`) returns early on `=== 0`, and
   * `#computeRefetchInterval` coerces `undefined` to `false` at `:206` — all three are "no
   * timer". The reason to return `false` is that it is the only unambiguous value at a
   * call site and in the exported type, not a runtime behaviour. A test whose stated
   * justification is checkably wrong is worse than none: the next reader verifies it,
   * finds it false, and concludes the whole guard is pointless.
   *
   * What is genuinely missing from a pure-helper file, by construction, is whether this
   * decision is ever CONSULTED — a page that never passes it to `refetchInterval` leaves
   * every test here green over a queue that does not poll. That guard cannot live here; it
   * lives in `src/tests/pages/apps/review/review-queue-poll.browser.test.tsx`, which
   * captures the options object each query is handed and calls the callbacks.
   */
});
