import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

const PAGE = 200;
/** Pages per run; anything past them waits for the next day. */
const MAX_PAGES = 20;

export type CsamTextRetentionSkip =
  | 'quoted-in-report'
  | 'pending-appeal'
  | 'evidence-hold'
  | 'unknown-owner';

type Candidate = {
  textId: number;
  skip: CsamTextRetentionSkip | null;
};

/**
 * The confirmed held PostText whose "none" report choice is a year old, with what keeps it
 * (`post_text_retention_skip`). `post_text_held` refuses the delete on its own grounds too.
 */
const candidatesSql = (afterId: number, limit: number) => Prisma.sql`
  SELECT t.id AS "textId",
    post_text_retention_skip(t."postId", t."userId") AS "skip"
  FROM "PostText" t
  WHERE t."csamHeld"
    AND t."csamConfirmedAt" <= (now() AT TIME ZONE 'UTC') - interval '1 year'
    AND EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = t.id AND h.label = 'csam'
        AND h.status = 'Confirmed' AND h.meta ->> 'reportChoice' = 'none'
    )
    AND t.id > ${afterId}
  ORDER BY t.id
  LIMIT ${limit}
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
  let afterId = 0;
  for (let i = 0; i < maxPages; i++) {
    const rows = await dbWrite.$queryRaw<Candidate[]>(candidatesSql(afterId, page));
    for (const row of rows) {
      if (row.skip) result.skipped[row.skip]++;
      else if (await purgeOne(row)) result.deleted++;
      else result.stillHeld++;
    }
    if (rows.length < page) break;
    afterId = rows[rows.length - 1].textId;
  }
  return result;
}

async function purgeOne({ textId }: Candidate): Promise<boolean> {
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
