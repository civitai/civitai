import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

const PAGE = 200;
/** Pages per run; purgeable texts past them wait for the next run. */
const MAX_PAGES = 20;

export type CsamTextRetentionSkip =
  | 'quoted-in-report'
  | 'pending-appeal'
  | 'evidence-hold'
  | 'unknown-owner';

/** Confirmed held PostText whose "none" report choice is a year old. */
const dueSql = Prisma.sql`
  FROM "PostText" t
  WHERE t."csamHeld"
    AND t."csamConfirmedAt" <= (now() AT TIME ZONE 'UTC') - interval '1 year'
    AND EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = t.id AND h.label = 'csam'
        AND h.status = 'Confirmed' AND h.meta ->> 'reportChoice' = 'none'
    )
`;

/** Due texts nothing keeps (`post_text_retention_skip`), so kept ones never use up the page budget. */
const purgeableSql = (afterId: number, limit: number) => Prisma.sql`
  SELECT t.id AS "textId"
  ${dueSql}
    AND post_text_retention_skip(t."postId", t."userId") IS NULL
    AND t.id > ${afterId}
  ORDER BY t.id
  LIMIT ${limit}
`;

const skipCountsSql = Prisma.sql`
  SELECT s.skip, count(*)::int AS "count"
  FROM (SELECT post_text_retention_skip(t."postId", t."userId") AS skip ${dueSql}) s
  WHERE s.skip IS NOT NULL
  GROUP BY s.skip
`;

export type CsamTextRetentionResult = {
  deleted: number;
  skipped: Record<CsamTextRetentionSkip, number>;
  /** Refused by the delete trigger: another hold `post_text_held` knows of still applies. */
  stillHeld: number;
};

/**
 * Deletes confirmed held PostText one year after a "none" report choice; the delete drops the hold's
 * copy of the text and its label-store snapshot with it. A skipped or refused row keeps all three.
 */
export async function purgeConfirmedCsamText({
  page = PAGE,
  maxPages = MAX_PAGES,
}: { page?: number; maxPages?: number } = {}): Promise<CsamTextRetentionResult> {
  const result: CsamTextRetentionResult = {
    deleted: 0,
    skipped: { 'quoted-in-report': 0, 'pending-appeal': 0, 'evidence-hold': 0, 'unknown-owner': 0 },
    stillHeld: 0,
  };
  const skips = await dbWrite.$queryRaw<{ skip: CsamTextRetentionSkip; count: number }[]>(
    skipCountsSql
  );
  for (const { skip, count } of skips) result.skipped[skip] = count;

  let afterId = 0;
  for (let i = 0; i < maxPages; i++) {
    const rows = await dbWrite.$queryRaw<{ textId: number }[]>(purgeableSql(afterId, page));
    for (const { textId } of rows) {
      if (await purgeOne(textId)) result.deleted++;
      else result.stillHeld++;
    }
    if (rows.length < page) break;
    afterId = rows[rows.length - 1].textId;
  }
  return result;
}

async function purgeOne(textId: number): Promise<boolean> {
  try {
    // The delete trigger drops the hold's copy and the label-store snapshot in the same statement, or
    // raises while any hold applies.
    await dbWrite.$executeRaw`DELETE FROM "PostText" WHERE id = ${textId}`;
    return true;
  } catch (error) {
    if (isHeldRefusal(error)) return false;
    throw error;
  }
}

const isHeldRefusal = (error: unknown) =>
  error instanceof Error && /cannot be deleted while it is held/.test(error.message);
