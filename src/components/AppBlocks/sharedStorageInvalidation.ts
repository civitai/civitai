import type { trpc } from '~/utils/trpc';

/**
 * Shared-storage read-cache invalidation for the App Blocks hosts.
 *
 * THE BUG CLASS this fixes: a block's own shared-storage WRITE was invisible to
 * its own next READ, for the entire lifetime of the page.
 *
 * Mechanism. The hosts serve every shared-storage read through
 * `trpc.useUtils().apps.shared.*.fetch(...)` — React Query's `fetchQuery`, which
 * resolves from cache whenever the entry is not stale. civitai's QueryClient sets
 * `staleTime: Infinity` globally (`~/utils/trpc`), so such an entry is NEVER
 * stale and `fetchQuery` never refetches it. The writes are separate mutations.
 * With no invalidation anywhere between them, the sequence
 *
 *     append/vote → list
 *
 * returns the pre-write snapshot until a full page reload. There was no
 * `invalidate` call in the whole `AppBlocks` directory before this module.
 *
 * Why invalidate the whole `apps.shared` namespace rather than the four read
 * procedures by name (`list`, `getCount`, `getCounts`, `get`): naming them is a
 * predicate that has to be repeated at every write site and updated whenever a
 * read is added, which is precisely how one of the twelve call sites ends up
 * stale. The namespace call cannot miss a future read. It is also cheap — these
 * are per-page caches holding at most a few shared-storage pages, and the only
 * queries under `apps.shared` ARE those reads (the writes are mutations, which
 * hold no query cache).
 *
 * 🔴 ORDERING IS LOAD-BEARING: callers must `await` this BEFORE posting the
 * `SHARED_*_RESULT` reply, never after. The SDK hook resolves on that reply and a
 * block is free to re-read immediately; invalidating afterwards races the read it
 * is meant to serve, and loses on exactly the fast path the caller cares about.
 * The tests pin the ordering, not just the call.
 *
 * Both hosts must call this for every shared-storage mutation — see
 * `hostHandlerParity.ts` for why the two hosts move in lockstep.
 */

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Drop the cached shared-storage reads so the next `fetch` goes to the server.
 *
 * Never throws: an invalidation failure must not turn a SUCCEEDED write into a
 * reported failure. The write is already committed by the time this runs, so the
 * honest outcome of a failed invalidation is a stale read, not an error reply —
 * reporting a failure here would tell the block its write did not land when it
 * did, which is strictly worse than the staleness this exists to prevent.
 */
export async function invalidateSharedStorageReads(utils: TrpcUtils): Promise<void> {
  try {
    await utils.apps.shared.invalidate();
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}
