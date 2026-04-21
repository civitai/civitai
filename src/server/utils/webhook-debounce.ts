/**
 * Webhook Debouncing for Article Image Scan Updates
 *
 * Coalesces bursts of image-scan webhooks for the same article into a single
 * scheduled `updateArticleImageScanStatus` call, without losing the final
 * "all images done" webhook in the burst.
 *
 * Uses Redis for distributed debouncing across multiple server instances.
 */

import type { RedisKeyStringsCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { logToAxiom } from '~/server/logging/client';
import { dbRead } from '~/server/db/client';
import { ImageConnectionType } from '~/server/common/enums';
import { updateArticleImageScanStatus } from '~/server/services/article.service';

/**
 * Debounce article update to coalesce bursts of concurrent webhooks.
 *
 * The lock is released *before* the update runs (not after). A webhook that
 * arrives while the update is in flight will then start a fresh debounce
 * cycle, guaranteeing the latest image state is eventually reconciled.
 * Concurrent updates for the same article are serialized inside
 * `updateArticleImageScanStatus` via `pg_advisory_xact_lock`, so early release
 * does not cause overlapping writes.
 *
 * @param articleId - Article to update
 */
export async function debounceArticleUpdate(articleId: number): Promise<void> {
  const key = `${REDIS_KEYS.ARTICLE.SCAN_UPDATE}:${articleId}` as RedisKeyStringsCache;

  try {
    const exists = await redis.get(key);

    if (!exists) {
      // Lock with 2s TTL so rapid-fire webhooks within the 1s delay window
      // are coalesced into this scheduled update.
      await redis.setEx(key, 2, '1');

      setTimeout(async () => {
        // Release the lock *before* running the update. Any webhook that
        // arrives during the update will then schedule its own follow-up
        // cycle, preventing the "lost last webhook" race.
        await redis.del(key).catch(() => {
          // Ignore — TTL will expire the key anyway.
        });
        try {
          await updateArticleImageScanStatus([articleId]);
        } catch (error) {
          await logToAxiom({
            name: 'article-scan-debounce',
            type: 'error',
            message: `updateArticleImageScanStatus failed: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`,
            articleId,
            stack: error instanceof Error ? error.stack : undefined,
          }).catch(() => null);
        }
      }, 1000);
    }
    // If key exists, the in-flight cycle will pick up this webhook's state
    // after it releases the lock and starts fresh on the next webhook.
  } catch (error) {
    await logToAxiom({
      name: 'article-scan-debounce',
      type: 'error',
      message: `Debounce failed, falling back to direct update: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      articleId,
    }).catch(() => null);
    // Fallback: run update immediately when Redis is unavailable.
    await updateArticleImageScanStatus([articleId]).catch(async (err) => {
      await logToAxiom({
        name: 'article-scan-debounce',
        type: 'error',
        message: `Fallback updateArticleImageScanStatus failed: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`,
        articleId,
        stack: err instanceof Error ? err.stack : undefined,
      }).catch(() => null);
    });
  }
}

/**
 * Fan out an image's terminal-state update to any articles that embed it.
 * Each article debounce call coalesces concurrent webhooks and runs
 * `recomputeArticleIngestion` so Blocked/Error/Scanned transitions all advance
 * article state.
 *
 * Callers are responsible for gating on the `articleImageScanning` feature flag
 * because the two webhook entrypoints resolve the flag differently (one reads
 * from a request context, the other receives it as a parameter).
 */
export async function fanOutArticleImageUpdates(imageId: number): Promise<void> {
  const articleConnections = await dbRead.imageConnection.findMany({
    where: { imageId, entityType: ImageConnectionType.Article },
    select: { entityId: true },
  });
  for (const { entityId } of articleConnections) {
    await debounceArticleUpdate(entityId);
  }
}
