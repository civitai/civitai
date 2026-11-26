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
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * GET endpoint to batch update Image.blockedFor to null for images with blockedFor = 'moderated',
 * nsfwLevel not in (0, 32) and ingestion not Blocked, since clearing blockedFor on a Blocked row
 * would leave it Blocked with no reason.
 * Secured for moderators only.
 */

// Image ids per scan step. `blockedFor` has no index outside ingestion='Blocked', so the scan walks
// the primary key in bounded ranges on the read replica instead of one full-table query.
const ID_RANGE = 500_000;

async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  logToAxiom(
    { type: 'info', name: 'unblock-images-handler-invoked', message: 'Handler invoked' },
    'webhooks'
  );

  const startedAt = Date.now();
  const candidateIds: number[] = [];

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
          AND ingestion <> ${ImageIngestionStatus.Blocked}::"ImageIngestionStatus"
      `;
      if (rows.length) {
        candidateIds.push(...rows.map((r) => r.id));
        console.log(
          `[unblock-images] ids ${from}-${from + ID_RANGE}: ${
            rows.length
          } eligible. Running total: ${candidateIds.length}`
        );
      }
    }

    console.log(`[unblock-images] Updating ${candidateIds.length} images in the database...`);
    // The scan read the replica; only rows still blocked for moderation on the primary, and still
    // matching the filter above, are cleared.
    const unblocked = await dbWrite.image.updateManyAndReturn({
      where: {
        id: { in: candidateIds },
        blockedFor: { in: ['moderated', 'Moderated'] },
        needsReview: null,
        nsfwLevel: { notIn: [0, NsfwLevel.Blocked] },
        ingestion: { not: ImageIngestionStatus.Blocked },
      },
      data: { blockedFor: null },
      select: { id: true },
    });
    const unblockedIds = unblocked.map((image) => image.id);
    console.log(
      `[unblock-images] DB update complete: cleared ${unblockedIds.length} of ${candidateIds.length} candidates.`
    );

    // Backstop: trg_blocked_image_delete_queue arms purge on a Blocked row; the update above
    // excludes them.
    await dropBlockedImageDeleteQueue(unblockedIds);

    // Update search index for the unblocked images
    console.log(`[unblock-images] Updating search index for ${unblockedIds.length} images...`);
    await queueImageSearchIndexUpdate({
      ids: unblockedIds,
      action: SearchIndexUpdateQueueAction.Update,
    });
    console.log(`[unblock-images] Search index update complete.`);

    // Track moderator activity for this batch
    console.log(`[unblock-images] Tracking moderator activity for user ${user.id}...`);
    await trackModActivity(user.id, {
      entityType: 'image',
      activity: 'review',
      entityId: unblockedIds,
    });
    console.log(`[unblock-images] Moderator activity tracked for user ${user.id}.`);

    const elapsed = Date.now() - startedAt;
    console.log(
      `[unblock-images] Completed. Total updated: ${unblockedIds.length}, Time: ${elapsed}ms`
    );

    return res.status(200).json({ updated: unblockedIds.length, ms: elapsed });
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
