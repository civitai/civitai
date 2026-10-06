import { Prisma } from '@prisma/client';
import { getHighestBrowsingLevelBit, NsfwLevel } from '@civitai/shared';
import { collectionRatingLevel } from '@civitai/shared/rating-review';
import {
  challengeDerivedNsfwLevel,
  type DerivedNsfwEntityType,
} from '@civitai/shared/rated-entity-sql';
import { dbWrite } from '~/server/db/client';
import { ratedEntityContentNsfwLevelSql } from '~/server/services/text-scan/scan-floor';

const table: Record<DerivedNsfwEntityType, Prisma.Sql> = {
  Post: Prisma.raw('"Post"'),
  Bounty: Prisma.raw('"Bounty"'),
  BountyEntry: Prisma.raw('"BountyEntry"'),
};

export async function computeRatedEntityDerivedNsfwLevel(
  entityType: DerivedNsfwEntityType | 'Challenge' | 'Crucible' | 'Collection',
  entityId: number
): Promise<number | null> {
  if (entityType === 'Crucible') {
    const row = await dbWrite.crucible.findUnique({
      where: { id: entityId },
      select: { nsfwLevel: true },
    });
    return row ? getHighestBrowsingLevelBit(row.nsfwLevel) || NsfwLevel.PG : null;
  }
  if (entityType === 'Collection') {
    const row = await dbWrite.collection.findUnique({
      where: { id: entityId },
      select: { nsfwLevel: true },
    });
    return row ? collectionRatingLevel(row.nsfwLevel) : null;
  }
  if (entityType === 'Challenge') {
    const row = await dbWrite.challenge.findUnique({
      where: { id: entityId },
      select: { allowedNsfwLevel: true },
    });
    return row ? challengeDerivedNsfwLevel(row.allowedNsfwLevel) : null;
  }
  const rows = await dbWrite.$queryRaw<{ derived: number }[]>(Prisma.sql`
    SELECT ${ratedEntityContentNsfwLevelSql(entityType, 'e')} AS derived
    FROM ${table[entityType]} e
    WHERE e.id = ${entityId}
  `);
  return rows[0]?.derived ?? null;
}
