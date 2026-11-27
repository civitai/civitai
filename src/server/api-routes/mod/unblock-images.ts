import { moderatorWithheldSql } from '@civitai/shared/retracted-media-tier';
import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import {
  dropBlockedImageDeleteQueue,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { withheldImageIds } from '~/server/services/moderator-withheld.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * GET endpoint to batch update Image.blockedFor to null for images with blockedFor = 'moderated',
 * nsfwLevel not in (0, 32) and ingestion not Blocked, since clearing blockedFor on a Blocked row
 * would leave it Blocked with no reason. An image withheld from the caller is left as it is.
 * Secured for moderators only.
 */

// Image ids per scan step. `blockedFor` has no index outside ingestion='Blocked', so the scan walks
// the primary key in bounded ranges on the read replica instead of one full-table query.
const ID_RANGE = 500_000;

const WITHHELD_CHECK_CHUNK = 5_000;

// Ids per primary UPDATE: each row re-reads the withheld rule, so one statement over every candidate
// holds its row locks for the whole run.
const UPDATE_CHUNK = 200;

export async function unblockModeratedImages(
  user: { id: number },
  { csamReview, updateChunk = UPDATE_CHUNK }: { csamReview: boolean; updateChunk?: number }
) {
  const candidateIds: number[] = [];
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
        `[unblock-images] ids ${from}-${from + ID_RANGE}: ${rows.length} eligible. Running total: ${
          candidateIds.length
        }`
      );
    }
  }

  const withheld = new Set<number>();
  for (let i = 0; i < candidateIds.length; i += WITHHELD_CHECK_CHUNK) {
    const ids = candidateIds.slice(i, i + WITHHELD_CHECK_CHUNK);
    for (const id of await withheldImageIds(ids, { csamReview })) withheld.add(id);
  }
  const unblockIds = candidateIds.filter((id) => !withheld.has(id));

  console.log(`[unblock-images] Updating ${unblockIds.length} images in the database...`);
  // The scan read the replica: the primary re-checks every condition.
  const unblocked: { id: number }[] = [];
  for (let i = 0; i < unblockIds.length; i += updateChunk) {
    const ids = unblockIds.slice(i, i + updateChunk);
    unblocked.push(
      ...(await dbWrite.$queryRaw<{ id: number }[]>`
        UPDATE "Image" i SET "blockedFor" = NULL, "updatedAt" = now()
        WHERE i.id = ANY(${ids}::int[])
          AND i."blockedFor" IN ('moderated', 'Moderated')
          AND i."needsReview" IS NULL
          AND i."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked})
          AND i.ingestion <> ${ImageIngestionStatus.Blocked}::"ImageIngestionStatus"
          AND NOT ${Prisma.raw(moderatorWithheldSql('i', { csamReview }))}
        RETURNING i.id
      `)
    );
  }
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

  return { updated: unblockedIds.length, withheld: withheld.size };
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  logToAxiom(
    { type: 'info', name: 'unblock-images-handler-invoked', message: 'Handler invoked' },
    'webhooks'
  );

  const startedAt = Date.now();
  try {
    const { updated } = await unblockModeratedImages(user, {
      csamReview: !!getFeatureFlags({ user, req }).csamReports,
    });
    const elapsed = Date.now() - startedAt;
    console.log(`[unblock-images] Completed. Total updated: ${updated}, Time: ${elapsed}ms`);

    return res.status(200).json({ updated, ms: elapsed });
  } catch (error) {
    return handleEndpointError(res, error);
  }
}

export default ModEndpoint(handler, ['GET']);
