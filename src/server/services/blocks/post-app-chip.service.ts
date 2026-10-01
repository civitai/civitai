/**
 * I/O wiring for the post-detail "Published with <app>" chip.
 *
 * Deliberately THIN and deliberately SEPARATE from `post-app-chip.ts`, which
 * holds the whole decision and is pure + I/O-injected. Keeping the two apart is
 * what lets the decision be tested in the node `unit` project without pulling in
 * `dbRead` or the Flipt client — the same split `app-listing-icon.service.ts`
 * uses against `listing-media-url.ts`.
 *
 * FAIL-OPEN, loudly-but-safely: this is decoration on a page that must render.
 * A failed read returns `null` (no chip) rather than taking the post detail down
 * with it. `null` covers every "nothing to show" case without distinguishing
 * them, because no caller can act on the difference.
 */
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import type { PostAppChip, PostAppChipRow } from '~/server/services/blocks/post-app-chip';
import {
  postAppChipQuery,
  postAppMarkerQuery,
  resolvePostAppChip,
} from '~/server/services/blocks/post-app-chip';
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
 * 🔴 The precondition matters: the only caller runs this after `getPostDetail`
 * has admitted the post, so neither read below re-derives the post's visibility.
 * Calling it on an unauthorised post id would disclose whether that post was
 * app-published.
 */
export async function readPostAppChip({
  postId,
  user,
}: {
  postId: number;
  user?: SessionUser;
}): Promise<PostAppChip | null> {
  try {
    return await resolvePostAppChip({
      postId,
      // SERVER-resolved, never re-derived from the client `features` object — see
      // the gate note in `post-app-chip.ts`.
      storeScope: await resolveStoreVisibilityScope({ user }),
      readPostMetadata: async (id) => {
        const row = await dbRead.post.findUnique(postAppMarkerQuery(id));
        return row?.metadata ?? null;
      },
      readApp: async (appId) =>
        (await dbRead.oauthClient.findUnique(postAppChipQuery(appId))) as PostAppChipRow | null,
    });
  } catch (err) {
    noteDegradedChipRead(err);
    return null;
  }
}
