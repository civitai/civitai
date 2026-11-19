import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

const PAGE = 200;
/** Pages per run; purgeable texts past them wait for the next run. */
const MAX_PAGES = 20;

export type CsamTextRetentionSkip =
  | 'quoted-in-report'
  | 'pending-appeal'
  | 'evidence-hold'
  | 'unknown-owner';

/** Confirmed held PostText a year past a confirmation where every confirmed hold chose "none". */
// Driven from the confirmed holds (`TextScanHold_status_createdAt_idx`), not a scan of PostText.
const dueSql = Prisma.sql`
  FROM "PostText" t
  WHERE t."csamHeld"
    AND t.id IN (
      SELECT h."entityId" FROM "TextScanHold" h
      WHERE h.status = 'Confirmed' AND h."entityType" = 'PostText' AND h.label = 'csam'
      GROUP BY h."entityId"
      HAVING max(h."decidedAt") <= (now() AT TIME ZONE 'UTC') - interval '1 year'
        AND bool_and(h.meta ->> 'reportChoice' IS NOT DISTINCT FROM 'none')
    )
`;

/**
 * Due texts nothing keeps (`post_text_retention_skip`) and the delete trigger would not refuse
 * (`post_text_held`), so kept ones never use up the page budget.
 */
const purgeableSql = (afterId: number, limit: number) => Prisma.sql`
  SELECT t.id AS "textId"
  ${dueSql}
    AND post_text_retention_skip(t."postId", t."userId") IS NULL
    AND NOT post_text_held(t.id, t."csamHeld", t."postId", t."userId")
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
  /** Deletes that raised anything else; logged by count, and the run goes on. */
  failed: number;
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
    failed: 0,
  };
  const skips = await dbWrite.$queryRaw<{ skip: CsamTextRetentionSkip; count: number }[]>(
    skipCountsSql
  );
  for (const { skip, count } of skips) result.skipped[skip] = count;

  let afterId = 0;
  for (let i = 0; i < maxPages; i++) {
    const rows = await dbWrite.$queryRaw<{ textId: number }[]>(purgeableSql(afterId, page));
    for (const { textId } of rows) {
      const outcome = await purgeOne(textId);
      if (outcome === 'deleted') result.deleted++;
      else if (outcome === 'held') result.stillHeld++;
      else result.failed++;
    }
    if (rows.length < page) break;
    afterId = rows[rows.length - 1].textId;
  }
  return result;
}

async function purgeOne(textId: number): Promise<'deleted' | 'held' | 'failed'> {
  try {
    // The delete trigger drops the hold's copy and the label-store snapshot in the same statement, or
    // raises while any hold applies.
    await dbWrite.$executeRaw`DELETE FROM "PostText" WHERE id = ${textId}`;
    return 'deleted';
  } catch (error) {
    if (isHeldRefusal(error)) return 'held';
    // Name and code only: a database message can echo the row.
    void logToAxiom({
      name: 'purge-confirmed-csam-text',
      type: 'error',
      message: 'csam text purge delete failed',
      payload: { textId },
      code: (error as { code?: unknown })?.code,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return 'failed';
  }
}

const isHeldRefusal = (error: unknown) =>
  error instanceof Error && /cannot be deleted while it is held/.test(error.message);
