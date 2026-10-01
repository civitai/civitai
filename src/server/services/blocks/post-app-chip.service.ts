/**
 * I/O wiring for the post-detail "Published with <app>" chip.
 *
 * Deliberately THIN and deliberately SEPARATE from `post-app-chip.logic.ts`,
 * which holds the whole decision and is pure + I/O-injected. Keeping the two
 * apart is what lets the decision be tested in the node `unit` project without
 * pulling in `dbRead` or the Flipt client — the same split
 * `app-listing-icon.service.ts` uses against `listing-media-url.ts`.
 *
 * 🔴 THIN IS NOT UNTESTED, AND THIS FILE IS WHERE THE DISCLOSURE GATE ACTUALLY
 * LIVES. Every interesting property of the decision is pinned in the logic
 * module's tests — and all of them stay green if `storeScope` here is replaced
 * with the literal `'full'`, if the allowlisted `select` is dropped from the
 * `oauthClient` read, or if the marker is read for the wrong post id. Measured:
 * those three mutants each survived the logic module's 32 tests untouched. The
 * builders being pinned says nothing about what is handed to Prisma.
 * `__tests__/post-app-chip.service.test.ts` is what closes that, and it is not
 * optional coverage.
 *
 * FAIL-OPEN, loudly: this is decoration on a page that must render, so a failed
 * read returns `null` (no chip) rather than taking the post detail down with it.
 * `null` covers every "nothing to show" case without distinguishing them to the
 * caller, because no caller can act on the difference — but the OUTCOME is
 * recorded, because from outside a total failure and an ordinary post look
 * identical and the chip could otherwise vanish site-wide unnoticed.
 */
import { dbRead } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import { recordPostAppChipRead } from '~/server/prom/post-app-chip.metrics';
import { recordStoreScopeApplied } from '~/server/prom/store-scope.metrics';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import type { PostAppChip, PostAppChipRow } from '~/server/services/blocks/post-app-chip.logic';
import {
  postAppChipQuery,
  postAppMarkerQuery,
  resolvePostAppChip,
} from '~/server/services/blocks/post-app-chip.logic';
import type { SessionUser } from '~/types/session';

/**
 * `logToAxiom` returns a promise that can reject, so the `.catch` is required —
 * an unhandled rejection from a fail-open path would defeat the point of failing
 * open. Mirrors `noteDegradedIconRead` in `app-listing-icon.service.ts`.
 */
function noteDegradedChipRead(err: unknown): void {
  logToAxiom({
    name: 'post-app-chip-read-degraded',
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
    code: (err as { code?: unknown })?.code ?? null,
  }).catch(() => null);
}

/**
 * Resolve the chip for a post the caller has ALREADY authorised for this viewer,
 * or `null`.
 *
 * 🔴 THE PRECONDITION IS THE CALLER'S, AND THIS FUNCTION CANNOT CHECK IT. The
 * only caller (`getPostHandler`) runs this after `getPostDetail` has admitted the
 * post and after the blocked-user check, and passes `post.id` — the id of the row
 * that was actually returned — never `input.id`. Neither read below re-derives
 * the post's visibility, deliberately: a second copy of that authorisation is a
 * second thing to diverge. The consequence is that calling this with an
 * unauthorised post id WOULD disclose whether that post was app-published, so a
 * new caller must establish the same precondition. It is stated rather than
 * enforced because the enforcement already exists one rung up and duplicating it
 * is the worse failure mode.
 */
export async function readPostAppChip({
  postId,
  user,
  host,
}: {
  postId: number;
  user?: SessionUser;
  /**
   * The request's host, for the store's maturity gate. Fail-closed on absence:
   * `ratingAllowedOnHost` refuses a mature rating when the host is empty, so a
   * missing host under-links rather than over-links.
   */
  host: string;
}): Promise<PostAppChip | null> {
  try {
    // SERVER-resolved, never re-derived from the client `features` object — see
    // the gate note in `post-app-chip.logic.ts`.
    const storeScope = await resolveStoreVisibilityScope({ user });
    // 🔴 Recorded so this surface is legible in the SAME pair the store surfaces
    // are read as. `store_scope_resolutions_total` now carries post-detail volume
    // whether or not we record here — the resolver instruments itself at its own
    // choke point, by design — so NOT recording the applied half is what would
    // break the documented comparison, by making post-detail visible on one side
    // of it only. ⚠️ Two consequences of that volume, recorded here because the
    // counters' own docs predate this caller: the `{principal="anon", scope="none"}`
    // series is now dominated by post views rather than store visits, so read it
    // sliced by the applied `entrypoint`; and `store_scope_divergence_total` can be
    // driven by page views rather than store reads, so an alert threshold on it
    // wants re-checking against post-detail traffic. The divergence STATE it
    // reports is unchanged — only the rate at which it is observed.
    recordStoreScopeApplied(storeScope, 'post-detail');

    const { chip, outcome } = await resolvePostAppChip({
      postId,
      storeScope,
      host,
      readPostMetadata: async (id) => {
        // 🔴 `getDbWithoutLag`, not a bare `dbRead` — the SAME routing
        // `getPostDetail` uses for this post. The chip's own write happens inside
        // the create-post transaction, so on a bare replica read the publishing
        // author's first view of their own post can miss the marker and show no
        // chip, which is the one view most likely to be looked at. The helper
        // routes to the primary while this post id is inside its lag window.
        const db = await getDbWithoutLag('post', id);
        const row = await db.post.findUnique(postAppMarkerQuery(id));
        return row?.metadata ?? null;
      },
      // The plain replica, deliberately: unlike the marker above, this row is not
      // written inside the post's own transaction — an
      // `OauthClient`/`AppBlock`/`AppListing` is approved long before any post is
      // published through it — so there is no lag window to route around.
      readApp: async (appId) =>
        (await dbRead.oauthClient.findUnique(postAppChipQuery(appId))) as PostAppChipRow | null,
    });
    recordPostAppChipRead(outcome);
    return chip;
  } catch (err) {
    noteDegradedChipRead(err);
    recordPostAppChipRead('degraded');
    return null;
  }
}
