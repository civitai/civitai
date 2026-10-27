import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  dropBlockedImageDeleteQueue,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * GET endpoint to batch update Image.blockedFor to null for images with blockedFor = 'moderated',
 * and nsfwLevel not in (0, 32).
 * Secured for moderators only.
 */

// Image ids per scan step. `blockedFor` has no index outside ingestion='Blocked', so the scan walks
// the primary key in bounded ranges on the read replica instead of one full-table query.
const ID_RANGE = 500_000;

async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  logToAxiom(
    { type: 'info', name: 'unblock-images-handler-invoked', message: 'Handler invoked' },
    'webhooks'
  ).catch();

  const startedAt = Date.now();
  const updatedIds: number[] = [];

  try {
    const [{ maxId }] = await dbRead.$queryRaw<{ maxId: number | null }[]>`
      SELECT max(id) AS "maxId" FROM "Image"
    `;
    for (let from = 0; from < (maxId ?? 0); from += ID_RANGE) {
      const rows = await dbRead.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Image"
        WHERE id > ${from} AND id <= ${from + ID_RANGE}
          AND "blockedFor" IN ('moderated', 'Moderated')
          AND "needsReview" IS NULL
          AND "nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked})
      `;
      if (rows.length) {
        updatedIds.push(...rows.map((r) => r.id));
        console.log(
          `[unblock-images] ids ${from}-${from + ID_RANGE}: ${
            rows.length
          } eligible. Running total: ${updatedIds.length}`
        );
      }
    }

    console.log(`[unblock-images] Updating ${updatedIds.length} images in the database...`);
    await dbWrite.image.updateMany({
      where: { id: { in: updatedIds } },
      data: { blockedFor: null },
    });
    console.log(`[unblock-images] DB update complete.`);

    // This clears `blockedFor` without touching `ingestion`, so any row still sitting at
    // ingestion='Blocked' would be armed for purge by trg_blocked_image_delete_queue on the
    // very update that was meant to unblock it.
    await dropBlockedImageDeleteQueue(updatedIds);

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
