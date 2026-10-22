import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { textScanEmEntityType } from '~/server/services/text-scan/mode';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

// Held text is personal data; 30 days leaves time to escalate a decided hold.
export const CSAM_HOLD_TEXT_RETENTION_DAYS = 30;

export const TEXT_SCAN_CLEAN_ROW_ENTITY_TYPES: TextScanEntityType[] = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'ResourceReview',
];

async function deleteInBatches(
  where: Prisma.EntityModerationWhereInput,
  batchSize: number,
  maxBatches: number
) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await dbWrite.entityModeration.findMany({
      where,
      select: { id: true },
      take: batchSize,
    });
    if (!rows.length) return { deleted, exhausted: false };
    const { count } = await dbWrite.entityModeration.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    deleted += count;
    if (rows.length < batchSize) return { deleted, exhausted: false };
  }
  return { deleted, exhausted: true };
}

export async function cleanupTextScanRows({
  graduatedEntityTypes,
  graduatedWebSearchEntityTypes = [],
  cleanRowEntityTypes = TEXT_SCAN_CLEAN_ROW_ENTITY_TYPES,
  olderThanDays,
  batchSize = 1000,
  maxBatches = 50,
}: {
  graduatedEntityTypes: TextScanEntityType[];
  /** Only their `:search-shadow` rows are deleted; the main `:shadow` rows follow `graduatedEntityTypes`. */
  graduatedWebSearchEntityTypes?: TextScanEntityType[];
  cleanRowEntityTypes?: TextScanEntityType[];
  olderThanDays: number;
  batchSize?: number;
  maxBatches?: number;
}) {
  const cutoff = decreaseDate(new Date(), olderThanDays, 'days');

  const shadowRowTypes = [
    ...graduatedEntityTypes.map((t) => textScanEmEntityType(t, 'shadow')),
    ...graduatedWebSearchEntityTypes.map((t) => textScanEmEntityType(t, 'shadow', 'web-search')),
  ];
  const shadow = shadowRowTypes.length
    ? await deleteInBatches(
        {
          entityType: { in: shadowRowTypes },
          updatedAt: { lt: cutoff },
        },
        batchSize,
        maxBatches
      )
    : { deleted: 0, exhausted: false };

  const clean = cleanRowEntityTypes.length
    ? await deleteInBatches(
        {
          entityType: {
            in: cleanRowEntityTypes.flatMap((t) => [t, textScanEmEntityType(t, 'shadow')]),
          },
          status: EntityModerationStatus.Succeeded,
          triggeredLabels: { isEmpty: true },
          updatedAt: { lt: cutoff },
        },
        batchSize,
        maxBatches
      )
    : { deleted: 0, exhausted: false };

  // Dismissed only: a Confirmed hold's text may be evidence, and its retention is not decided yet. A
  // migration-superseded duplicate was never reviewed, so it goes only once the hold that replaced it is
  // dismissed too (a missing one keeps it); it keeps its marker, which the hold writer and the queue read
  // to tell it from a ruling.
  const holdCutoff = decreaseDate(new Date(), CSAM_HOLD_TEXT_RETENTION_DAYS, 'days').toISOString();
  const holdTextCleared = await dbWrite.$executeRaw`
    UPDATE "TextScanHold" h SET
      "text" = '',
      "meta" = CASE WHEN h."meta"->>'decision' = 'superseded'
        THEN jsonb_build_object('decision', 'superseded', 'superseded', true,
          'supersededBy', h."meta"->'supersededBy')
        END,
      "updatedAt" = now()
    WHERE h."status" = 'Dismissed' AND h."text" <> ''
      AND h."decidedAt" < (${holdCutoff}::timestamptz AT TIME ZONE 'UTC')
      AND (h."meta"->>'decision' IS DISTINCT FROM 'superseded' OR EXISTS (
        SELECT 1 FROM "TextScanHold" k
        -- Only a plain integer is cast: one bad value must not abort the whole sweep.
        WHERE k."id" = CASE WHEN h."meta"->>'supersededBy' ~ '^[0-9]{1,9}$'
            THEN (h."meta"->>'supersededBy')::int END
          AND k."status" = 'Dismissed'
          AND k."decidedAt" < (${holdCutoff}::timestamptz AT TIME ZONE 'UTC')))
  `;

  return {
    shadowDeleted: shadow.deleted,
    cleanDeleted: clean.deleted,
    holdTextCleared,
    exhausted: shadow.exhausted || clean.exhausted,
  };
}
