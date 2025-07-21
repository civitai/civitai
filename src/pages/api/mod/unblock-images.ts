import { uniq } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';
import { dbWrite } from '~/server/db/client';
import { getImagesFromSearch, queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { ImageSort, NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * GET endpoint to batch update Image.blockedFor to null for images with blockedFor = 'moderated',
 * and nsfwLevel not in (0, 32).
 * Secured for moderators only.
 */

const BATCH_LIMIT = 100;

async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  logToAxiom(
    { type: 'info', name: 'unblock-images-handler-invoked', message: 'Handler invoked' },
    'webhooks'
  );

  const startedAt = Date.now();
  const updatedIds: number[] = [];

  try {
    let batchCount = 0;
    let offset = 0;

    while (true) {
      console.log(
        `[unblock-images] Fetching images: offset=${offset}, limit=${BATCH_LIMIT}, batch=${
          batchCount + 1
        }}`
      );
      const { data: images } = await getImagesFromSearch({
        browsingLevel: allBrowsingLevelsFlag,
        limit: BATCH_LIMIT,
        offset,
        period: MetricTimeframe.AllTime,
        periodMode: 'published',
        sort: ImageSort.Newest,
        isModerator: true,
        withMeta: false,
        include: [],
        blockedFor: ['moderated', 'Moderated'],
      });
      if (!images.length) {
        console.log(
          `[unblock-images] No more images to update. Finished at offset=${offset}, total batches=${batchCount}.`
        );
        break;
      }

      // Only update images that match the additional criteria (needsReview: null, nsfwLevel)
      const filtered = images.filter(
        (img) => img.needsReview == null && ![0, NsfwLevel.Blocked].includes(img.nsfwLevel)
      );
      const ids = uniq(filtered.map((img) => img.id));
      if (ids.length > 0) {
        updatedIds.push(...ids);
        console.log(
          `[unblock-images] Batch ${batchCount + 1}: Found ${
            ids.length
          } eligible images (filtered from ${images.length}). Running total: ${updatedIds.length}`
        );
      } else {
        console.log(
          `[unblock-images] Batch ${
            batchCount + 1
          }: No eligible images in this batch (filtered from ${images.length}).`
        );
      }

      batchCount++;
      offset += BATCH_LIMIT;
    }

    console.log(`[unblock-images] Updating ${updatedIds.length} images in the database...`);
    await dbWrite.image.updateMany({
      where: { id: { in: updatedIds } },
      data: { blockedFor: null },
    });
    console.log(`[unblock-images] DB update complete.`);

    // Update search index for the unblocked images
    console.log(`[unblock-images] Updating search index for ${updatedIds.length} images...`);
    await queueImageSearchIndexUpdate({
      ids: updatedIds,
      action: SearchIndexUpdateQueueAction.Update,
    });
    console.log(`[unblock-images] Search index update complete.`);

    // Track moderator activity for this batch
    console.log(`[unblock-images] Tracking moderator activity for user ${user.id}...`);
    await trackModActivity(user.id, {
      entityType: 'image',
      activity: 'review',
      entityId: updatedIds,
    });
    console.log(`[unblock-images] Moderator activity tracked for user ${user.id}.`);

    const elapsed = Date.now() - startedAt;
    console.log(
      `[unblock-images] Completed. Total updated: ${updatedIds.length}, Time: ${elapsed}ms`
    );

    return res.status(200).json({ updated: updatedIds.length, ms: elapsed });
  } catch (error) {
    const e = error as Error;
    console.error('[unblock-images] Error:', e);
    logToAxiom({
      type: 'error',
      name: 'mod-unblock-images-error',
      message: e.message,
      stack: e.stack,
    });

    return res.status(500).json({
      error: 'Internal Server Error',
      message: e.message,
      ...(process.env.NODE_ENV === 'development' && { stack: e.stack }),
    });
  }
}

export default ModEndpoint(handler, ['GET']);
