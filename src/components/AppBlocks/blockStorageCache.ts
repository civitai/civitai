import type { trpc } from '~/utils/trpc';

/**
 * Read-cache policy for the App Blocks storage bridges (shared AND per-user).
 *
 * THE PROBLEM. civitai's QueryClient sets `staleTime: Infinity` globally
 * (`~/utils/trpc`), and both hosts serve every storage read through
 * `trpcUtils.apps.{shared,storage}.*.fetch` — React Query's `fetchQuery`, which
 * resolves straight from cache whenever the entry is not stale. Under an
 * infinite staleTime such an entry is never stale, and there was no
 * invalidation anywhere in this directory. Two distinct defects fall out:
 *
 *   1. A block could not see its OWN write. `append/vote → list` returned the
 *      pre-write snapshot.
 *   2. A block could not see ANYONE ELSE'S write. The shared store is
 *      cross-user by definition — a votes/requests board, a leaderboard — so an
 *      infinite staleTime means a viewer never observes another user's activity
 *      without reloading the page. Invalidating on the local write does nothing
 *      for this half, because the writer is a different browser.
 *
 * THE POLICY, and why it is two mechanisms rather than one:
 *
 *   - `BLOCK_STORAGE_READ_STALE_TIME_MS` bounds (2). A short staleTime, not
 *     `0`: these reads are `publicProcedure`s that hit the per-app Postgres
 *     schema directly and carry NO server-side read rate limit (only the writes
 *     do). The cache is therefore the only thing bounding a block that polls in
 *     a loop, and `staleTime: 0` would remove that incidental protection while
 *     buying nothing a 1s bound does not already give.
 *   - `invalidate*` bounds (1). A user who votes should see the count move
 *     immediately, not up to a second later, so the local write drops the
 *     cached reads outright.
 *
 * A CONSEQUENCE WORTH KNOWING (measured against `@tanstack/query-core@5.101.0`):
 * an invalidation can be undone by a read that was already in flight when it
 * ran — `successState()` sets `isInvalidated: false`, so a fetch started before
 * the write and resolving after it re-marks its pre-write data as fresh. The
 * staleTime bound is what stops that being permanent: worst case the block sees
 * its own write one staleTime late, instead of never. Cancelling the in-flight
 * read instead would abort a legitimate concurrent read, which is worse.
 *
 * 🔴 ORDERING IS LOAD-BEARING for the invalidation: callers must `await` it
 * BEFORE posting the `*_RESULT` reply, never after. The SDK hook resolves on
 * that reply and a block is free to re-read immediately; invalidating
 * afterwards races the read it is meant to serve. The tests pin the ordering,
 * not merely the call.
 *
 * Both hosts must apply BOTH halves — see `hostHandlerParity.ts` for why the
 * two hosts move in lockstep. `blockStorageCacheParity.test.ts` enforces it.
 */

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Staleness bound for every block storage read, shared and per-user alike.
 *
 * 1s is chosen to be imperceptible to a viewer watching another user's activity
 * while still collapsing a runaway poll to at most one round-trip per second
 * per key. It is deliberately NOT `0` — see the policy note above.
 */
export const BLOCK_STORAGE_READ_STALE_TIME_MS = 1_000;

/** Options every block storage read passes to `fetch`. */
export const BLOCK_STORAGE_READ_OPTS = { staleTime: BLOCK_STORAGE_READ_STALE_TIME_MS } as const;

/**
 * Drop the cached CROSS-USER shared reads (`list`/`get`/`getCount`/`getCounts`)
 * so the block's own next read goes to the server.
 *
 * Invalidates the `apps.shared` NAMESPACE rather than the four read procedures
 * by name: naming them is a predicate that must be repeated at every write site
 * and updated whenever a read is added, which is how one site ends up stale.
 * The only queries under this namespace ARE those reads — the writes are
 * mutations and hold no query cache.
 *
 * Never throws. The write is already committed by the time this runs, so a
 * failure here must not turn a SUCCEEDED write into a reported failure: the
 * block would tell the user it failed and a retry could duplicate the row. The
 * honest outcome of a failed invalidation is a read that is stale for one
 * staleTime, which is what the bound above already guarantees.
 */
export async function invalidateSharedStorageReads(utils: TrpcUtils): Promise<void> {
  try {
    await utils.apps.shared.invalidate();
  } catch {
    // Intentionally swallowed — see above. Pinned by a test that makes
    // invalidate reject and asserts the write still reports success.
  }
}

/**
 * The per-user (private KV) counterpart. Same defect, same reasoning: an
 * `APP_STORAGE_SET`/`DELETE` followed by the block's own `get`/`list` was
 * served the pre-write value.
 */
export async function invalidatePrivateStorageReads(utils: TrpcUtils): Promise<void> {
  try {
    await utils.apps.storage.invalidate();
  } catch {
    // Intentionally swallowed — see invalidateSharedStorageReads.
  }
}
