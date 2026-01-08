/**
 * Webhook Debouncing for Article Image Scan Updates
 *
 * Critical performance optimization: Prevents N+1 webhook calls for articles with many images
 * Example: Article with 50 images = 50 webhooks → 1 actual DB update (98% reduction)
 *
 * Uses Redis for distributed debouncing across multiple server instances
 */

import type { RedisKeyStringsCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { updateArticleImageScanStatus } from '~/server/services/article.service';

/**
 * Debounce article update to prevent concurrent webhook processing
 *
 * When multiple images from the same article complete scanning simultaneously,
 * this ensures only one database update happens.
 *
 * @param articleId - Article to update
 */
export async function debounceArticleUpdate(articleId: number): Promise<void> {
  const key = `${REDIS_KEYS.ARTICLE.SCAN_UPDATE}:${articleId}` as RedisKeyStringsCache;

  try {
    const exists = await redis.get(key);

    if (!exists) {
      // Set lock with 2s TTL to prevent rapid successive updates
      await redis.setEx(key, 2, '1');

      // Schedule update after short delay to let other webhooks arrive
      setTimeout(async () => {
        try {
          await updateArticleImageScanStatus([articleId]);
        } catch (error) {
          console.error(`Failed to update article ${articleId} scan status:`, error);
        } finally {
          // Clean up lock
          await redis.del(key).catch(() => {
            // Ignore cleanup errors - lock will expire anyway
          });
        }
      }, 1000); // 1s delay allows other concurrent webhooks to arrive
    }
    // If key exists, another webhook already scheduled the update - skip
  } catch (error) {
    console.error(`Debounce failed for article ${articleId}:`, error);
    // Fallback: Update immediately if Redis fails
    await updateArticleImageScanStatus([articleId]).catch((err) => {
      console.error(`Fallback update failed for article ${articleId}:`, err);
    });
  }
}
