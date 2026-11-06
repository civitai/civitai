import { TRPCError } from '@trpc/server';
import { createPostWithImagesHandler } from '~/server/controllers/post.controller';
import type { ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { stageGenerationOutputImage } from '~/server/services/blocks/block-image-upload.service';
import { createRemixGallerySubmission } from '~/server/services/remix-gallery.service';
import { domainSpendType } from '~/server/utils/buzz-helpers';

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

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Longer than a post with a few images takes to ingest, so a slow first tap is not posted twice. */
const PENDING_TTL_SECONDS = 5 * 60;
const PENDING = 'pending';

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

  const key =
    `${REDIS_SYS_KEYS.HEADLESS_POST.IDEMPOTENCY}:${ctx.user.id}:${idempotencyKey}` as const;
  const fresh = await sysRedis.set(key, PENDING, { NX: true, EX: PENDING_TTL_SECONDS });
  if (fresh === null) {
    const stored = await sysRedis.get(key);
    if (!stored || stored === PENDING)
      throw new TRPCError({ code: 'CONFLICT', message: 'This is already being posted.' });
    const first = JSON.parse(stored) as HeadlessPostResult;
    // A gallery asked for on the repeat, or refused the first time. Safe to send again: the gallery
    // takes one image once (`Placement_surface_target_image_live_key`), and refuses before it charges.
    if (remixGallery && !first.gallery?.submitted) {
      first.gallery = await submitToGallery(ctx, remixGallery, first.imageIds[0]);
      await storeResult(key, first);
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
    await sysRedis.del(key).catch(() => undefined);
    throw error;
  }

  // Recorded before any charge. A repeat after the pending key lapses would post again, so a
  // post the key cannot vouch for is never sent to a paid gallery.
  const recorded = await storeResult(key, result);
  if (remixGallery)
    result.gallery = recorded
      ? await submitToGallery(ctx, remixGallery, result.imageIds[0])
      : { submitted: false, reason: GALLERY_NOT_SENT };
  if (result.gallery) await storeResult(key, result);
  logToAxiom({
    name: 'headless-post',
    type: 'info',
    surface,
    postId: result.postId,
    gallery: result.gallery ? result.gallery.submitted : undefined,
  }).catch(() => undefined);
  return { ...result, deduped: false };
}

const GALLERY_NOT_SENT = 'It was not sent to the Remix gallery. Post again to send it.';

/** The result for repeats of `key`; false when it could not be stored. */
async function storeResult(
  key: `${typeof REDIS_SYS_KEYS.HEADLESS_POST.IDEMPOTENCY}:${string}`,
  result: HeadlessPostResult
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stored = await sysRedis
      .set(key, JSON.stringify(result), { EX: IDEMPOTENCY_TTL_SECONDS })
      .then(() => true)
      .catch(() => false);
    if (stored) return true;
  }
  logToAxiom({
    name: 'headless-post',
    type: 'error',
    message: 'the result for repeats could not be stored',
    postId: result.postId,
  }).catch(() => undefined);
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
      hostImageId,
      imageId,
    }).catch(() => undefined);
    return { submitted: false, reason: GALLERY_NOT_SENT };
  }
}
