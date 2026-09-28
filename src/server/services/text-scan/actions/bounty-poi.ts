import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { createNotification } from '~/server/services/notification.service';
import { buildTextScanFlagEntry, TEXT_SCAN_FLAGS_KEY } from '~/server/services/text-scan/flag-snapshot';
import type { PoiMinorResult } from '~/server/services/text-scan/actions/model-poi-minor';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';

function queueBountyIndex(id: number, action: SearchIndexUpdateQueueAction) {
  return SearchIndexUpdate.queueUpdate({ indexName: BOUNTIES_SEARCH_INDEX, items: [{ id, action }] });
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
