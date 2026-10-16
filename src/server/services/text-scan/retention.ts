import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { textScanEmEntityType } from '~/server/services/text-scan/mode';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';

// The held text is personal data; a month leaves room to escalate a decided hold by hand.
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

  const { count: holdTextCleared } = await dbWrite.textScanHold.updateMany({
    where: {
      // Confirmed retention is decided with the Confirm feature.
      status: 'Dismissed',
      decidedAt: { lt: decreaseDate(new Date(), CSAM_HOLD_TEXT_RETENTION_DAYS, 'days') },
      text: { not: '' },
    },
    data: { text: '', meta: Prisma.DbNull },
  });

  return {
    shadowDeleted: shadow.deleted,
    cleanDeleted: clean.deleted,
    holdTextCleared,
    exhausted: shadow.exhausted || clean.exhausted,
  };
}
