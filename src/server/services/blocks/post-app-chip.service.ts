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
import { readListingVisibilityMany } from '~/server/services/blocks/app-listing-visibility.service';
import { listingVisibleInStore } from '~/shared/utils/app-listing-visibility';
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
    // of it only.
    //
    // ⚠️ ONE consequence of that volume, recorded here because the counters' own
    // docs predate this caller: `{principal="anon", scope="none"}` is now dominated
    // by post views rather than store visits, so slice by the applied `entrypoint`
    // before reading either counter as a statement about the store.
    //
    // ⚠️ AND ONE NON-CONSEQUENCE, written down because this comment asserted it as
    // a hazard and that was WRONG — do not re-derive it. `store_scope_divergence_total`
    // is NOT driven at page-view rate by this caller, so no alert threshold on it
    // needs re-checking. `reportSilentStoreGate` does run on every logged-in
    // post-detail read that resolves `none`, but it re-reads the same three flags
    // with the SAME (flag, entityId, context) triple the async path just evaluated
    // — so the same eval-cache key, a hit, the same `false` — and returns before
    // touching the counter or Axiom. A real divergence needs the 10s eval-cache
    // entry to lapse BETWEEN the async and sync reads and the 60s config poll to
    // have flipped the answer inside that window.
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
        //
        // ⚠️ KNOWN DUPLICATE, accepted while the gate is narrow. `getPostDetail`
        // already called `getDbWithoutLag('post', id)` for this same id earlier in
        // the same request, and nothing memoises the ANSWER (the helper memoises
        // the store, not the result) — so a scope-`full` post view makes two Redis
        // GETs on one key, and two primary reads inside the lag window. Trivial
        // today because only mods + app-dev-testers reach it; the fix, if the gate
        // widens, is to thread one db handle down from the handler rather than to
        // drop to bare `dbRead`, which would reintroduce the read-your-writes bug
        // above.
        const db = await getDbWithoutLag('post', id);
        const row = await db.post.findUnique(postAppMarkerQuery(id));
        return row?.metadata ?? null;
      },
      // The plain replica, deliberately: unlike the marker above, this row is not
      // written inside the post's own transaction — an
      // `OauthClient`/`AppBlock`/`AppListing` is approved long before any post is
      // published through it — so there is no lag window to route around.
      //
      // 🔴 NOT CACHED, AND THAT IS A DECISION WITH A NAMED TRIGGER. This row is
      // near-static and shared across every post the app made, so it is the
      // obvious `createCachedObject` (`~/server/redis/caches.ts`, fetch-by-id-array)
      // candidate. It is deliberately not cached YET: the read fires only for a
      // scope-`full` viewer on an app-published post, which is a near-zero rate, so
      // a cache would add invalidation surface for no measured saving. The trigger
      // is `post_app_chip_reads_total{outcome="chip"}` — when that stops being
      // near-zero, build it.
      // 🔴 THE LEVEL TERM. One batched raw statement for every candidate listing, because
      // the column is `// @no-type` and therefore unreachable through the Prisma delegate.
      // Resolved for the `public` floor only — strictly narrower than any real viewer's
      // floor, so it can only UNDER-link, never link a page the store would refuse. A
      // missing column yields an empty map, i.e. pre-feature behaviour.
      readHiddenListingIds: async (listingIds) => {
        const levels = await readListingVisibilityMany(listingIds, dbRead);
        const hidden = new Set<string>();
        for (const id of listingIds) {
          const level = levels.get(id);
          if (!level) continue;
          if (
            !listingVisibleInStore({
              status: 'approved',
              visibility: level.visibility,
              floor: 'public',
            })
          ) {
            hidden.add(id);
          }
        }
        return hidden;
      },
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
