import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import type { EntityMetric_MetricType_Type } from '~/shared/utils/prisma/enums';
import { updateEntityMetric } from './metric-helpers';

// @dev: Replace this with a redis cache by adding a imagePostCache to caches.ts and using that instead...
const imagePostCache = new Map<number, { postId: number | null; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get postId for an image, with caching
 */
async function getImagePostId(imageId: number): Promise<number | null> {
  // Check cache first
  const cached = imagePostCache.get(imageId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.postId;
  }

  // Fetch from database
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { postId: true },
  });

  // Cache the result
  imagePostCache.set(imageId, {
    postId: image?.postId ?? null,
    timestamp: Date.now(),
  });

  // Clean up old cache entries periodically
  if (imagePostCache.size > 1000 && imagePostCache.size % 100 === 0) {
    const now = Date.now();
    for (const [key, value] of imagePostCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        imagePostCache.delete(key);
      }
    }
  }

  return image?.postId ?? null;
}

/**
 * Track metrics for an image and optionally its parent post
 * This helper reduces repetition when tracking image metrics that should also apply to posts
 */
export async function trackImageAndPostMetric({
  ctx,
  imageId,
  metricType,
  amount = 1,
}: {
  ctx: DeepNonNullable<Context>;
  imageId: number;
  metricType: EntityMetric_MetricType_Type;
  amount?: number;
}) {
  // Track for the image
  await updateEntityMetric({
    ctx,
    entityType: 'Image',
    entityId: imageId,
    metricType,
    amount,
  });

  // Track for the post if image belongs to one
  const postId = await getImagePostId(imageId);
  if (postId) {
    await updateEntityMetric({
      ctx,
      entityType: 'Post',
      entityId: postId,
      metricType,
      amount,
    });
  }
}
