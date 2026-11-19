import { TRPCError } from '@trpc/server';
import { createPostWithImagesHandler } from '~/server/controllers/post.controller';
import type { ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import {
  claimIdempotencyKey,
  IdempotencyUnavailableError,
  type IdempotencyClaim,
} from '~/server/services/idempotency-key.service';
import { stageGenerationOutputImage } from '~/server/services/blocks/block-image-upload.service';
import { createRemixGallerySubmission } from '~/server/services/remix-gallery.service';
import { domainSpendType } from '~/server/utils/buzz-helpers';
import { throwServiceUnavailableError } from '~/server/utils/errorHandling';

/**
 * One-click posting: generation outputs to a post, with no editor. Each image goes through
 * `addPostImage`, so provenance, ingestion and the NSFW scan are the same as an editor upload.
 */

export type HeadlessPostMedia = {
  /** The workflow that made it: `addPostImage` reads the run's signed provenance from it. */
  workflowId: string;
  /** An orchestrator output url the server resolved itself, never one a client sent. */
  url: string;
  width?: number | null;
  height?: number | null;
};

export type HeadlessPostGallery = {
  hostImageId: number;
  method: 'free' | 'team' | 'paid';
  /** The price the poster was shown; required for `paid`. */
  expectedPrice?: number;
};

export type HeadlessPostGalleryResult = { submitted: true } | { submitted: false; reason: string };

export type HeadlessPostResult = {
  postId: number;
  imageIds: number[];
  gallery?: HeadlessPostGalleryResult;
};

export type HeadlessPostSurface = 'remix-app';

const GALLERY_PREFIX = /^remix gallery: /;

export async function createHeadlessPost({
  ctx,
  media,
  title,
  detail,
  tags,
  publish,
  remixGallery,
  idempotencyKey,
  surface,
}: {
  ctx: ProtectedContext;
  media: HeadlessPostMedia[];
  title?: string;
  detail?: string;
  tags?: string[];
  publish: boolean;
  /** Submitted after the post exists; a refusal keeps the post and returns its reason. */
  remixGallery?: HeadlessPostGallery;
  /** A repeat with the same key returns the first post. */
  idempotencyKey: string;
  surface: HeadlessPostSurface;
}): Promise<HeadlessPostResult & { deduped: boolean }> {
  if (!media.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing to post' });
  // Before the bytes are copied to the store: blocked text writes nothing.
  await throwOnBlockedUserContent([title, detail], {
    isModerator: ctx.user.isModerator,
    surface: 'post',
  });

  const claim = await claimIdempotencyKey(
    'headless-post',
    `${ctx.user.id}:${idempotencyKey}`
  ).catch((error) => {
    // The key store is on but unusable (its table not applied, or Postgres down): post nothing,
    // rather than post without a guard. The tap fails and can be retried.
    if (error instanceof IdempotencyUnavailableError)
      throw throwServiceUnavailableError('Posting is unavailable right now. Try again.', error);
    throw error;
  });
  if (claim.status !== 'claimed') {
    if (claim.status !== 'done' || !claim.result)
      throw new TRPCError({ code: 'CONFLICT', message: 'This is already being posted.' });
    const first = JSON.parse(claim.result) as HeadlessPostResult;
    // A gallery asked for on the repeat, or refused the first time. Safe to send again: the gallery
    // takes one image once (`Placement_surface_target_image_live_key`), and refuses before it charges.
    if (remixGallery && !first.gallery?.submitted) {
      first.gallery = await submitToGallery(ctx, remixGallery, first.imageIds[0]);
      await storeResult(claim, first);
    }
    return { ...first, deduped: true };
  }

  let result: HeadlessPostResult;
  try {
    const staged = await Promise.all(
      media.map(({ url, width, height }) =>
        stageGenerationOutputImage({
          imageUrl: url,
          width: width ?? null,
          height: height ?? null,
          source: `headless-post:${surface}`,
        })
      )
    );
    const post = await createPostWithImagesHandler({
      input: {
        title,
        detail,
        tags,
        publish,
        images: staged.map((image, index) => ({
          ...image,
          type: 'image' as const,
          index,
          generationWorkflowId: media[index].workflowId,
          serverMintedUrl: true,
        })),
      },
      ctx,
    });
    result = { postId: post.id, imageIds: post.imageIds };
  } catch (error) {
    await claim.release().catch(() => undefined);
    throw error;
  }

  // Recorded before any charge. A repeat after the pending key lapses would post again, so a
  // post the key cannot vouch for is never sent to a paid gallery.
  const recorded = await storeResult(claim, result);
  if (remixGallery)
    result.gallery = recorded
      ? await submitToGallery(ctx, remixGallery, result.imageIds[0])
      : { submitted: false, reason: GALLERY_NOT_SENT };
  if (result.gallery) await storeResult(claim, result);
  logToAxiom({
    name: 'headless-post',
    type: 'info',
    surface,
    postId: result.postId,
    gallery: result.gallery ? result.gallery.submitted : undefined,
  });
  return { ...result, deduped: false };
}

const GALLERY_NOT_SENT = 'It was not sent to the Remix gallery. Post again to send it.';

/** The result for repeats of `key`; false when it could not be stored. */
async function storeResult(claim: IdempotencyClaim, result: HeadlessPostResult) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stored = await claim
      .store(JSON.stringify(result))
      .then(() => true)
      .catch(() => false);
    if (stored) return true;
  }
  logToAxiom({
    name: 'headless-post',
    type: 'error',
    message: 'the result for repeats could not be stored',
    postId: result.postId,
  });
  return false;
}

async function submitToGallery(
  ctx: ProtectedContext,
  { hostImageId, method, expectedPrice }: HeadlessPostGallery,
  imageId: number
): Promise<HeadlessPostGalleryResult> {
  if (!ctx.features.remixGallery)
    return { submitted: false, reason: 'The Remix gallery is not available yet.' };
  try {
    await createRemixGallerySubmission({
      placerId: ctx.user.id,
      hostImageId,
      imageId,
      expectedPrice,
      free: method === 'free',
      teamWaiver: method === 'team',
      spendType: domainSpendType(ctx.features),
    });
    return { submitted: true };
  } catch (error) {
    const message = (error as Error).message;
    // The gallery's own refusals are written for the submitter; anything else is not.
    if (error instanceof TRPCError && GALLERY_PREFIX.test(message)) {
      const reason = message.replace(GALLERY_PREFIX, '');
      return { submitted: false, reason: reason.charAt(0).toUpperCase() + reason.slice(1) };
    }
    logToAxiom({
      name: 'headless-post',
      type: 'error',
      message: `remix gallery submit failed: ${message}`,
      imageId,
      payload: { hostImageId },
    });
    return { submitted: false, reason: GALLERY_NOT_SENT };
  }
}
