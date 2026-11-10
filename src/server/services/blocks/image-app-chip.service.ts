/**
 * The IMAGE detail page's "Published with <app>" chip.
 *
 * An image an App Block published carries `Image.metadata.blockPublishedAppId`
 * (stamped by `persistBlockWorkflowOutputImage`). Some of those images belong to
 * a post — whose own `Post.metadata` carries the same marker and already renders
 * the chip on the post page — and some are bare images with no post at all, so
 * the image page reads the IMAGE's marker rather than borrowing the post's.
 *
 * 🔴 NOTHING IS DECIDED HERE. Everything after "which app id does this image
 * name" — the store-scope gate, the allowlisted `OauthClient` read, the four
 * viewability terms, the maturity silence, the icon gate, the name sanitiser,
 * the fail-open catch and the outcome counter — is the post chip's code, called
 * through `readAppChip` (`post-app-chip.service.ts`) and `resolveAppChip`
 * (`post-app-chip.logic.ts`). Read those headers for the constraints; this file
 * only supplies the image's marker.
 *
 * ## 🔴 The ORDER: authorise, THEN read the marker, keyed on the AUTHORISED row
 *
 * The post chip relies on its caller (`getPostHandler`) having admitted the post
 * first. This surface has its own query (`image.getPublishedWithApp`), because
 * the image page renders from whichever payload carried the image there — a feed
 * page, a post's image list, or `image.get` — so there is no single image read to
 * attach the chip to. So the authorisation happens HERE, with the same two rules
 * `image.get` applies:
 *
 *   1. `assertImageVisibleToViewer` — `image.get`'s visibility predicate plus its
 *      blocked-user check (the shared helper, not a re-spelling of either);
 *   2. `viewerCanSeeImageMedia` — `image.get`'s media rule. Where `image.get`
 *      withholds the media (and drops the event decoration), no chip either.
 *
 * Both run inside `readMarker`, which `resolveAppChip` calls only AFTER the store
 * scope gate — so for a viewer the store does not admit (today: everyone but
 * moderators and app-dev-testers) this costs no image read at all. The marker is
 * then read by the id of the row the check RETURNED, never the raw input id.
 *
 * A not-visible image answers `null` rather than throwing: it is "nothing this
 * viewer may see", not a degraded read, and the answer is the same `null` a
 * hand-made image gets, so the endpoint discloses nothing about images the
 * viewer cannot open.
 */
import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { BLOCK_PUBLISHED_APP_ID_META_KEY } from '~/server/services/blocks/block-image-upload.service';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip.logic';
import { readAppIdMarker } from '~/server/services/blocks/post-app-chip.logic';
import { readAppChip } from '~/server/services/blocks/post-app-chip.service';
import { assertImageVisibleToViewer } from '~/server/services/image-visibility.service';
import { viewerCanSeeImageMedia, type MediaViewer } from '~/server/utils/image-media-visibility';

/**
 * Resolve the chip for image `imageId` as THIS viewer would see it, or `null`.
 * Fail-open: any error is `null` (and counted `degraded`), never a thrown read.
 */
export async function readImageAppChip({
  imageId,
  ctx,
  host,
  viewerBrowsingLevel,
}: {
  imageId: number;
  ctx: MediaViewer & Pick<Context, 'user'>;
  /** The request's host, for the store's maturity gate. Fail-closed on absence. */
  host: string;
  /** The viewer's browsing level, for the icon's red-host media ceiling. */
  viewerBrowsingLevel?: number | null;
}): Promise<PostAppChip | null> {
  return readAppChip({
    surface: 'image',
    entrypoint: 'image-detail',
    user: ctx.user,
    host,
    viewerBrowsingLevel,
    readMarker: async () => {
      let visible: Awaited<ReturnType<typeof assertImageVisibleToViewer>>;
      try {
        visible = await assertImageVisibleToViewer({
          id: imageId,
          userId: ctx.user?.id,
          isModerator: ctx.user?.isModerator,
        });
      } catch (err) {
        // Not visible (or blocked) — the helper's only refusal is NOT_FOUND. Anything
        // else is a real failure and reaches the fail-open catch as `degraded`.
        if (err instanceof TRPCError && err.code === 'NOT_FOUND') return null;
        throw err;
      }
      if (!(await viewerCanSeeImageMedia(ctx, visible))) return null;
      const row = await dbRead.image.findUnique({
        where: { id: visible.id },
        select: { metadata: true },
      });
      // 🔴 The IMAGE writer's own constant, never a re-spelled literal.
      return readAppIdMarker(row?.metadata ?? null, BLOCK_PUBLISHED_APP_ID_META_KEY);
    },
  });
}
