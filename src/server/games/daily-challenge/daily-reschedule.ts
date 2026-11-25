import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';

export type RescheduleRow = {
  id: number;
  title: string | null;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  startsAt: Date;
  visibleAt: Date;
  judgeId: number | null;
  judgingCategories: unknown;
  metadata: unknown;
};

export function preImage(row: RescheduleRow) {
  return {
    title: row.title,
    description: row.description,
    theme: row.theme,
    invitation: row.invitation,
    themeElements: parseChallengeMetadata(row.metadata).themeElements ?? [],
    judgingCategories: row.judgingCategories,
    judgeId: row.judgeId,
    dailyPlan: parseChallengeMetadata(row.metadata).dailyPlan ?? null,
  };
}
export const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// One guard for the candidate SELECT and the UPDATE, so the write can never be wider than the list.
export function guardSql(rubricOnly: boolean) {
  return Prisma.sql`c.source = 'System'
      AND c.status = 'Scheduled'
      AND c."startsAt" > now()
      AND (${rubricOnly} OR c."visibleAt" > now())
      AND NOT EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c."collectionId")`;
}

export async function eligibleRows(
  where: { ids?: number[]; from?: string; to?: string },
  rubricOnly: boolean
) {
  const ids = where.ids ?? [];
  return dbRead.$queryRaw<RescheduleRow[]>`
    SELECT c.id, c.title, c.description, c.theme, c.invitation, c."startsAt", c."visibleAt",
           c."judgeId", c."judgingCategories", c.metadata
    FROM "Challenge" c
    WHERE ${guardSql(rubricOnly)}
      AND (${ids.length === 0} OR c.id = ANY(${ids}::int[]))
      AND (${!where.from} OR c."startsAt" >= ${where.from ?? '1970-01-01'}::date)
      AND (${!where.to} OR c."startsAt" < (${where.to ?? '1970-01-01'}::date + 1))
    ORDER BY c."startsAt"
  `;
}

/** True when the row already carries the plan its date resolves to now (same set, same judge). */
export function planIsCurrent(
  row: Pick<RescheduleRow, 'metadata'>,
  plan: { setKey: string; judgeName: string } | undefined
) {
  const stored = parseChallengeMetadata(row.metadata).dailyPlan;
  if (!stored || !plan) return false;
  return stored.setKey === plan.setKey && stored.judgeName === plan.judgeName;
}
