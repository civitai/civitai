import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

const PAGE = 200;
/** Pages per run; anything past them waits for the next day. */
const MAX_PAGES = 20;

export type CsamTextRetentionSkip = 'quoted-in-report' | 'pending-appeal' | 'evidence-hold';

type Candidate = {
  textId: number;
  holdId: number;
  skip: CsamTextRetentionSkip | null;
};

/**
 * The confirmed held PostText whose "none" report choice is a year old, with why it must stay. A text
 * quoted in any CSAM report follows that report's retention; a pending appeal or any evidence hold row
 * of the owner, released or not, keeps it. `post_text_held` refuses the delete on its own grounds too.
 */
const candidatesSql = (afterId: number, limit: number) => Prisma.sql`
  SELECT t.id AS "textId", h.id AS "holdId",
    CASE
      WHEN EXISTS (
        SELECT 1 FROM "CsamReport" r
        WHERE jsonb_typeof(r.details -> 'contextText') = 'array'
          AND r.details -> 'contextText' @> jsonb_build_array(jsonb_build_object('postId', t."postId"))
      ) THEN 'quoted-in-report'
      WHEN EXISTS (
        SELECT 1 FROM "Appeal" a WHERE a."userId" = t."userId" AND a.status = 'Pending'
      ) THEN 'pending-appeal'
      WHEN EXISTS (SELECT 1 FROM "EvidenceHold" e WHERE e."userId" = t."userId") THEN 'evidence-hold'
    END AS "skip"
  FROM "PostText" t
  JOIN "TextScanHold" h
    ON h."entityType" = 'PostText' AND h."entityId" = t.id AND h.label = 'csam'
   AND h.status = 'Confirmed'
  WHERE t."csamHeld"
    AND t."csamConfirmedAt" <= (now() AT TIME ZONE 'UTC') - interval '1 year'
    AND h.meta ->> 'reportChoice' = 'none'
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
 * Deletes confirmed held PostText one year after a "none" report choice, and in the same transaction
 * drops the hold's copy of the text and its label-store snapshot. A skipped or refused row keeps all three.
 */
export async function purgeConfirmedCsamText({
  page = PAGE,
  maxPages = MAX_PAGES,
}: { page?: number; maxPages?: number } = {}): Promise<CsamTextRetentionResult> {
  const result: CsamTextRetentionResult = {
    deleted: 0,
    skipped: { 'quoted-in-report': 0, 'pending-appeal': 0, 'evidence-hold': 0 },
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

async function purgeOne({ textId, holdId }: Candidate): Promise<boolean> {
  try {
    await dbWrite.$transaction(async (tx) => {
      // The trigger asks `post_text_held` and raises while any hold applies, undoing all three.
      await tx.$executeRaw`DELETE FROM "PostText" WHERE id = ${textId}`;
      await tx.$executeRaw`
        UPDATE "TextScanHold"
        SET "text" = '',
            "meta" = (CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END)
              || jsonb_build_object('retentionPurgedAt', now())
        WHERE id = ${holdId}
      `;
      await tx.$queryRaw`SELECT label_store.exclude('post_text_text', ${String(
        textId
      )}::text, 'retention')`;
    });
    return true;
  } catch (error) {
    if (isHeldRefusal(error)) return false;
    throw error;
  }
}

const isHeldRefusal = (error: unknown) =>
  error instanceof Error && /cannot be deleted while it is held/.test(error.message);
