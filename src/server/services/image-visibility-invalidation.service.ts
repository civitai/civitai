import { ogImageUrl, modelOgEndpoint } from '~/components/Meta/og-image-url';
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
 * the models it can be the cover or showcase of, the articles it is the cover or banner of, and
 * the bounties it is attached to.
 */
export async function getImageOgCardUrls(imageId: number) {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { postId: true, post: { select: { modelVersion: { select: { modelId: true } } } } },
  });
  const postModelId = image?.post?.modelVersion?.modelId;
  const [models, articles, bounties] = await Promise.all([
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
    ...bounties.map(({ entityId }) => `/api/og?type=bounty&id=${entityId}`),
  ].map(ogImageUrl);
}

/**
 * Drops the shared copies that can still show an image after a moderator changes who may see it:
 * link-preview cards, the 404 gallery, its resources and the model galleries it is in. A viewer's
 * own copies expire on their short TTLs. Never throws: a failed purge is logged, and the copies
 * expire on their own.
 */
export async function invalidateImageVisibilityCaches(imageId: number) {
  try {
    const urls = await getImageOgCardUrls(imageId);
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
      purgeCache({ urls, tags: [IMAGE_404_CACHE_TAG, imageResourcesEdgeTag(imageId)] }),
      redis.purgeTags([IMAGE_404_CACHE_TAG]),
      image?.postId ? bustCachesForPosts(image.postId) : undefined,
      modelVersionId ? deleteImagesForModelVersionCache(modelVersionId) : undefined,
    ]);
  } catch (error) {
    logToAxiom({
      type: 'warning',
      name: 'image-visibility-invalidation',
      message: 'image visibility cache invalidation failed',
      payload: { imageId },
      error: safeError(error),
    });
  }
}
