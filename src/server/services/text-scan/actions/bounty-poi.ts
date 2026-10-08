import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { createNotification } from '~/server/services/notification.service';
import { resolveEntityAppeal } from '~/server/services/report.service';
import {
  loadTextScanTextHash,
  queueTextScanRescan,
} from '~/server/services/text-scan/actions/appeal-text-hash';
import {
  buildTextScanFlagEntry,
  hasOpenTextScanFlag,
  readTextScanFlags,
  TEXT_SCAN_FLAGS_KEY,
} from '~/server/services/text-scan/flag-snapshot';
import type { PoiMinorResult } from '~/server/services/text-scan/actions/model-poi-minor';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

function queueBountyIndex(id: number, action: SearchIndexUpdateQueueAction) {
  return SearchIndexUpdate.queueUpdate({
    indexName: BOUNTIES_SEARCH_INDEX,
    items: [{ id, action }],
  });
}

export async function applyBountyPoi({
  entityId,
  workflowId,
  outcome,
  textHash,
}: ApplyTextScanArgs): Promise<PoiMinorResult> {
  if (!outcome.poi?.detected) return { notified: false };

  const entry = JSON.stringify(
    buildTextScanFlagEntry({
      workflowId,
      reason: outcome.poi.reason,
      names: outcome.poi.names,
      textHash,
    })
  );
  const [flagged] = await dbWrite.$queryRaw<{ id: number; name: string; userId: number | null }[]>`
    UPDATE "Bounty" b
    SET poi = TRUE,
        availability = 'Private'::"Availability",
        "lockedProperties" = ARRAY(
          SELECT DISTINCT unnest(COALESCE(b."lockedProperties", ARRAY[]::text[]) || ARRAY['poi']::text[])
        ),
        meta = COALESCE(b.meta, '{}'::jsonb) || jsonb_build_object(
          ${TEXT_SCAN_FLAGS_KEY}, COALESCE(b.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
            'poi', ${entry}::jsonb || jsonb_build_object(
              'at', now(),
              'promptIds', (SELECT em.result->'promptIds' FROM "EntityModeration" em
                            WHERE em."entityType" = 'Bounty' AND em."entityId" = b.id),
              'model', (SELECT em.result->'model' FROM "EntityModeration" em
                        WHERE em."entityType" = 'Bounty' AND em."entityId" = b.id),
              'prev', jsonb_build_object('availability', b.availability, 'lockedProperties', to_jsonb(COALESCE(b."lockedProperties", ARRAY[]::text[])))
            )
          )
        )
    WHERE b.id = ${entityId}
      AND (
        (b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' IS NULL
          AND NOT ('poi' = ANY(COALESCE(b."lockedProperties", ARRAY[]::text[]))))
        OR (b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'appealGranted' IS NOT NULL
          AND b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'appealGranted'->>'textHash' IS DISTINCT FROM ${textHash})
      )
    RETURNING b.id, b.name, b."userId"
  `;
  if (!flagged) return { notified: false };

  await queueBountyIndex(entityId, SearchIndexUpdateQueueAction.Delete);

  const notify = !!flagged.userId && flagged.userId > 0;
  if (notify)
    await createNotification({
      userId: flagged.userId!,
      type: 'bounty-text-scan-flagged',
      category: NotificationCategory.System,
      key: `bounty-text-scan-flagged:${entityId}:${workflowId}`,
      details: { bountyId: entityId, bountyName: flagged.name },
    });

  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'poi flag applied',
    entityType: 'Bounty',
    entityId,
    workflowId,
  }).catch(() => null);
  return { notified: notify };
}

export async function resolveBountyPoiAppeal({
  bountyId,
  uphold,
  userId,
}: {
  bountyId: number;
  uphold: boolean;
  userId: number;
}) {
  const bounty = await dbWrite.bounty.findUnique({
    where: { id: bountyId },
    select: { poi: true, meta: true },
  });
  let rescanQueued = false;

  if (uphold) {
    if (!bounty?.poi || !hasOpenTextScanFlag(bounty.meta, 'poi'))
      throw throwBadRequestError('This bounty is no longer flagged');
    await dbWrite.$executeRaw`
      UPDATE "Bounty" b
      SET meta = jsonb_set(
        b.meta,
        ARRAY[${TEXT_SCAN_FLAGS_KEY}::text, 'poi', 'appealUpheld'],
        jsonb_build_object('at', now(), 'by', ${userId}::int, 'via', 'appeal')
      )
      WHERE b.id = ${bountyId} AND b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' IS NOT NULL
    `;
  } else {
    const currentHash = await loadTextScanTextHash('Bounty', bountyId);
    if (!currentHash)
      throw throwBadRequestError(
        "Could not read this bounty's text, so the grant cannot record what it covers. The appeal is still open."
      );
    const flaggedHash = readTextScanFlags(bounty?.meta)?.poi?.textHash;
    rescanQueued = !!flaggedHash && flaggedHash !== currentHash;
    const restored = await dbWrite.$executeRaw`
      UPDATE "Bounty" b
      SET poi = FALSE,
          availability = COALESCE((b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->'prev'->>'availability')::"Availability", 'Public'::"Availability"),
          "lockedProperties" = ARRAY(
            SELECT DISTINCT unnest(COALESCE(b."lockedProperties", ARRAY[]::text[]) || ARRAY['poi']::text[])
          ),
          meta = jsonb_set(
            b.meta,
            ARRAY[${TEXT_SCAN_FLAGS_KEY}::text, 'poi', 'appealGranted'],
            jsonb_build_object(
              'at', now(),
              'by', ${userId}::int,
              'textHash', COALESCE(b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->>'textHash', ${currentHash}::text),
              'via', 'appeal'
            )
          )
      WHERE b.id = ${bountyId} AND b.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' IS NOT NULL
    `;
    if (restored) await queueBountyIndex(bountyId, SearchIndexUpdateQueueAction.Update);
  }

  await resolveEntityAppeal({
    ids: [bountyId],
    entityType: EntityType.Bounty,
    status: uphold ? AppealStatus.Rejected : AppealStatus.Approved,
    userId,
  });

  if (rescanQueued) await queueTextScanRescan('Bounty', bountyId);
  return { rescanQueued };
}
