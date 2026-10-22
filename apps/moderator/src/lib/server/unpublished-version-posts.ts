import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead, dbWrite } from './db';
import { flagClearHoldLegs, holdMarkerState } from './csam-flag-clear';
import { insertModActivityBatch } from './mod-activity';
import { SYSTEM_USER_ID } from './users.service';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';

/**
 * Other users' published posts made with a model version (or model) a moderator unpublished, put in
 * front of moderators as one Admin Attention post report each, filed by the system account. A report
 * changes nothing on the post or its images: they stay live until a moderator rules on the report.
 *
 * Which unpublish reasons count is the caller's input, never a list in this file.
 */

/** Marks the reports this job files, so a rerun skips every post it already reported. */
export const ENQUEUE_SOURCE = 'unpublished-version-posts';
export const ENQUEUE_ACTIVITY = 'enqueueUnpublishedVersionPost';
const PAGE_SIZE = 500;

export type Exclusion =
  | 'noImages'
  | 'imageNotClear'
  | 'posterBanned'
  | 'posterHeld'
  | 'alreadyQueued';

type CandidateRow = {
  postId: number;
  modelId: number;
  modelVersionId: number;
  unpublishedReason: string;
  level: 'version' | 'model';
} & Record<Exclusion, boolean>;

const UNPUBLISHED = sql`('Unpublished', 'UnpublishedViolation')`;

/** One keyset page of candidate posts after `cursor`, each with the reasons it would be skipped. */
async function candidatePage(
  db: Kysely<DB>,
  reasons: string[],
  cursor: number,
  limit: number
): Promise<CandidateRow[]> {
  const marker = await holdMarkerState(db);
  // Not `c`: the hold legs alias "CsamReport" as c, which would shadow it.
  const held = flagClearHoldLegs(sql<number>`cand."posterId"`, marker);
  const { rows } = await sql<CandidateRow>`
    -- Driven from the pulled versions, materialized: joined from Post instead, the planner walks the
    -- Post primary key from the cursor and reads the whole table to fill a page.
    WITH pulled AS MATERIALIZED (
      SELECT mv.id AS "modelVersionId", m.id AS "modelId", m."userId" AS "ownerId",
        CASE WHEN mv.status IN ${UNPUBLISHED} AND mv.meta ->> 'unpublishedReason' = ANY(${reasons}::text[])
             THEN 'version' ELSE 'model' END AS level,
        CASE WHEN mv.status IN ${UNPUBLISHED} AND mv.meta ->> 'unpublishedReason' = ANY(${reasons}::text[])
             THEN mv.meta ->> 'unpublishedReason' ELSE m.meta ->> 'unpublishedReason' END AS "unpublishedReason"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE (mv.status IN ${UNPUBLISHED} AND mv.meta ->> 'unpublishedReason' = ANY(${reasons}::text[]))
         OR (m.status IN ${UNPUBLISHED} AND m.meta ->> 'unpublishedReason' = ANY(${reasons}::text[]))
    ), cand AS (
      SELECT p.id AS "postId", p."userId" AS "posterId", pulled."modelId", pulled."modelVersionId",
        pulled.level, pulled."unpublishedReason"
      FROM pulled
      -- LATERAL with its own LIMIT, so it stays a per-version index lookup. A plain join is planned as
      -- a merge join over the whole Post(modelVersionId) index.
      CROSS JOIN LATERAL (
        SELECT p.id, p."userId" FROM "Post" p
        WHERE p."modelVersionId" = pulled."modelVersionId"
          AND p.id > ${cursor}
          AND p."publishedAt" IS NOT NULL AND p."publishedAt" <= now()
          AND p."userId" <> pulled."ownerId"
        ORDER BY p.id
        LIMIT ${limit}
      ) p
      ORDER BY p.id
      LIMIT ${limit}
    )
    SELECT cand."postId", cand."modelId", cand."modelVersionId", cand.level, cand."unpublishedReason",
      NOT EXISTS (SELECT 1 FROM "Image" i WHERE i."postId" = cand."postId") AS "noImages",
      EXISTS (
        SELECT 1 FROM "Image" i
        WHERE i."postId" = cand."postId"
          AND (i.ingestion <> 'Scanned' OR i."needsReview" = ${FLAG_KEPT_THROUGH_BLOCK} OR i."blockedFor" = 'CSAM')
      ) AS "imageNotClear",
      EXISTS (SELECT 1 FROM "User" u WHERE u.id = cand."posterId" AND u."bannedAt" IS NOT NULL) AS "posterBanned",
      (${sql.join(Object.values(held), sql` OR `)}) AS "posterHeld",
      EXISTS (
        SELECT 1 FROM "PostReport" pr
        JOIN "Report" r ON r.id = pr."reportId"
        WHERE pr."postId" = cand."postId" AND r."userId" = ${SYSTEM_USER_ID}
          AND r.details ->> 'source' = ${ENQUEUE_SOURCE}
      ) AS "alreadyQueued"
    FROM cand
    ORDER BY cand."postId"
  `.execute(db);
  return rows;
}

const EXCLUSIONS: Exclusion[] = [
  'alreadyQueued',
  'noImages',
  'imageNotClear',
  'posterBanned',
  'posterHeld',
];

/** The first reason a post is skipped, in a fixed order so each skipped post is counted once. */
const exclusionOf = (row: CandidateRow): Exclusion | undefined => EXCLUSIONS.find((e) => row[e]);

export type EnqueuePlan = {
  /** Posts a real run would report now. */
  eligible: number;
  excluded: Record<Exclusion, number>;
  byReason: Record<string, number>;
};

/** Walks every candidate page and counts what a real run would do. Writes nothing. */
export async function planEnqueue(
  reasons: string[],
  db: Kysely<DB> = dbRead,
  pageSize = PAGE_SIZE
): Promise<EnqueuePlan> {
  const plan: EnqueuePlan = {
    eligible: 0,
    excluded: Object.fromEntries(EXCLUSIONS.map((e) => [e, 0])) as Record<Exclusion, number>,
    byReason: {},
  };
  for (let cursor = 0; ; ) {
    const page = await candidatePage(db, reasons, cursor, pageSize);
    for (const row of page) {
      const excluded = exclusionOf(row);
      if (excluded) plan.excluded[excluded]++;
      else {
        plan.eligible++;
        plan.byReason[row.unpublishedReason] = (plan.byReason[row.unpublishedReason] ?? 0) + 1;
      }
    }
    if (page.length < pageSize) return plan;
    cursor = page[page.length - 1].postId;
  }
}

export type EnqueueResult =
  | { ok: true; reported: number; plan: EnqueuePlan }
  | { ok: false; reason: 'countChanged'; plan: EnqueuePlan }
  /** A page failed. The pages before it are filed and `reported` counts them; a rerun skips them. */
  | { ok: false; reason: 'failed'; reported: number; plan: EnqueuePlan };

/**
 * Files one report per eligible post. Refused unless `expectedCount` is what a plan read from the
 * primary says now, and never files more than that count, though a post that became eligible since
 * the plan can take the place of one that stopped being. Each page is one transaction under one
 * advisory lock, and re-checks its posts inside it, so two concurrent runs cannot report a post
 * twice and a page that fails reports nothing.
 */
export async function enqueueUnpublishedVersionPosts({
  reasons,
  expectedCount,
  moderatorId,
  pageSize = PAGE_SIZE,
}: {
  reasons: string[];
  expectedCount: number;
  moderatorId: number;
  pageSize?: number;
}): Promise<EnqueueResult> {
  const plan = await planEnqueue(reasons, dbWrite, pageSize);
  if (plan.eligible !== expectedCount) return { ok: false, reason: 'countChanged', plan };

  let reported = 0;
  try {
    for (let cursor = 0; reported < expectedCount; ) {
      const remaining = expectedCount - reported;
      const { size, last, filed } = await dbWrite.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${ENQUEUE_SOURCE}))`.execute(trx);
        const page = await candidatePage(trx, reasons, cursor, pageSize);
        const filedIds: number[] = [];
        for (const row of page) {
          if (filedIds.length >= remaining) break;
          if (exclusionOf(row)) continue;
          const report = await trx
            .insertInto('Report')
            .values({
              userId: SYSTEM_USER_ID,
              reason: 'AdminAttention',
              status: 'Pending',
              details: JSON.stringify({
                source: ENQUEUE_SOURCE,
                reason: 'Made with an unpublished resource',
                comment: `Made with model version ${row.modelVersionId} (model ${row.modelId}), which a moderator unpublished (${row.unpublishedReason}). Review the post against the ToS.`,
                modelId: row.modelId,
                modelVersionId: row.modelVersionId,
                unpublishedReason: row.unpublishedReason,
                unpublishedLevel: row.level,
              }),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('PostReport')
            .values({ reportId: report.id, postId: row.postId })
            .execute();
          filedIds.push(row.postId);
        }
        await insertModActivityBatch(trx, {
          userId: moderatorId,
          entityType: 'post',
          entityIds: filedIds,
          activity: ENQUEUE_ACTIVITY,
        });
        return { size: page.length, last: page[page.length - 1]?.postId, filed: filedIds.length };
      });
      reported += filed;
      if (size < pageSize || last === undefined) break;
      cursor = last;
    }
  } catch (e) {
    console.error('[unpublished-version-posts] a page failed', { reported, error: e });
    return { ok: false, reason: 'failed', reported, plan };
  }
  return { ok: true, reported, plan };
}
