import { ogImageUrl, modelOgEndpoint } from '~/components/Meta/og-image-url';
import { env } from '~/env/server';
import { purgeCache } from '~/server/cloudflare/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
import { ModelStatus } from '~/shared/utils/prisma/enums';

/** Tags `image.get404Images`'s Redis and edge entries. */
export const IMAGE_404_CACHE_TAG = 'image-404';
/** Tags `image.getResources`'s edge entries for one image. */
export const imageResourcesEdgeTag = (imageId: number) => `image-resources-${imageId}`;

/**
 * The link-preview card urls that can draw this image: its own card, and the cards of its post,
 * the models it can be the cover or showcase of, the articles it is the cover or banner of, the
 * challenges it is the cover of, and the bounties it is attached to.
 */
export async function getImageOgCardUrls(imageId: number) {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { postId: true, post: { select: { modelVersion: { select: { modelId: true } } } } },
  });
  const postModelId = image?.post?.modelVersion?.modelId;
  const [models, articles, challenges, bounties] = await Promise.all([
    dbRead.model.findMany({
      where: {
        OR: [
          { coverImageId: imageId },
          { sfwCoverImageId: imageId },
          ...(postModelId ? [{ id: postModelId }] : []),
        ],
      },
      select: {
        id: true,
        updatedAt: true,
        modelVersions: {
          where: { status: ModelStatus.Published },
          select: { id: true, status: true },
          orderBy: { index: 'asc' },
          take: 1,
        },
      },
    }),
    dbRead.article.findMany({
      where: { OR: [{ coverId: imageId }, { bannerId: imageId }] },
      select: { id: true },
    }),
    dbRead.challenge.findMany({ where: { coverImageId: imageId }, select: { id: true } }),
    dbRead.imageConnection.findMany({
      where: { imageId, entityType: 'Bounty' },
      select: { entityId: true },
    }),
  ]);
  return [
    `/api/og?type=image&id=${imageId}`,
    ...(image?.postId ? [`/api/og?type=post&id=${image.postId}`] : []),
    ...models.map(modelOgEndpoint),
    ...articles.map(({ id }) => `/api/og?type=article&id=${id}`),
    ...challenges.map(({ id }) => `/api/og?type=challenge&id=${id}`),
    ...bounties.map(({ entityId }) => `/api/og?type=bounty&id=${entityId}`),
  ].map(ogImageUrl);
}

/**
 * A refill read from the replica before it has the change would cache the old copy again, so the
 * purge runs once more after this long.
 */
export const VISIBILITY_REPURGE_DELAY_MS = Math.max(env.REPLICATION_LAG_DELAY, 10) * 1000;

/**
 * Drops the shared copies that can still show an image after a moderator changes who may see it:
 * link-preview cards, the 404 gallery, its resources and the model galleries it is in. A viewer's
 * own copies expire on their short TTLs. Purges now and again after VISIBILITY_REPURGE_DELAY_MS.
 * Never throws: a failed step is logged and the others still run.
 */
export async function invalidateImageVisibilityCaches(imageId: number) {
  await purgeImageVisibilityCaches(imageId);
  const repurge = setTimeout(
    () => void purgeImageVisibilityCaches(imageId),
    VISIBILITY_REPURGE_DELAY_MS
  );
  repurge.unref?.();
}

async function purgeImageVisibilityCaches(imageId: number) {
  // Each step runs and fails on its own, so one failure leaves the other copies purged.
  const logFailure = (name: string) => (error: unknown) =>
    logToAxiom({
      type: 'warning',
      name: 'image-visibility-invalidation',
      message: `image visibility cache invalidation failed: ${name}`,
      payload: { imageId },
      error: safeError(error),
    });
  const step = (name: string, fn: () => Promise<unknown>) =>
    Promise.resolve().then(fn).catch(logFailure(name));
  await Promise.all([
    step('edge', async () => {
      const urls = await getImageOgCardUrls(imageId).catch((error) => {
        logFailure('card urls')(error);
        return [];
      });
      await purgeCache({ urls, tags: [IMAGE_404_CACHE_TAG, imageResourcesEdgeTag(imageId)] });
    }),
    step('404 gallery', () => redis.purgeTags([IMAGE_404_CACHE_TAG])),
    step('galleries', () => bustImageGalleryCaches(imageId)),
  ]);
}

async function bustImageGalleryCaches(imageId: number) {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { postId: true, post: { select: { modelVersionId: true } } },
  });
  // Lazy: post.service and image.service sit in the image.service import cycle.
  const [{ bustCachesForPosts }, { deleteImagesForModelVersionCache }] = await Promise.all([
    import('~/server/services/post.service'),
    import('~/server/services/image.service'),
  ]);
  const modelVersionId = image?.post?.modelVersionId;
  await Promise.all([
    image?.postId ? bustCachesForPosts(image.postId) : undefined,
    modelVersionId ? deleteImagesForModelVersionCache(modelVersionId) : undefined,
  ]);
}
