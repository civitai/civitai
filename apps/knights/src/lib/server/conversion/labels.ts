import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { utc } from '@civitai/db/kysely';
import { heldSql } from './held';

export type LabelCursor = { settledAt: Date; itemId: number; playerId: number };
export type LabelBatch = {
  scanned: number;
  /** Labels this batch added; a vote whose label already existed counts as scanned only. */
  written: number;
  /** Votes the label store would not take; they stay unlabelled and the next pass retries them. */
  failed: number;
  cursor: LabelCursor | null;
};

/** Gives every choice question a label-store `rule` row (`minHuman` = votes to resolve, not unanimous). Idempotent. */
export async function ensureQuestionRules(db: Kysely<DB>): Promise<void> {
  await sql`
    INSERT INTO label_store.rule ("question", "questionVersion", "minHuman", "requireUnanimous")
    SELECT q."key", q."version", q."votesToResolve", false
    FROM "KnightsQuestion" q
    WHERE q."kind" = 'choice'
    ON CONFLICT DO NOTHING
  `.execute(db);
}

/**
 * One `knight` label per settled vote at or before `settledBefore`, for players not held. The store never retracts a label, so a held player's votes stay unwritten and unmarked until released.
 * The player appears in the source ref only as the store's own hash, never as a user id. A vote whose image is gone is only marked.
 */
export async function writeLabelBatch(
  db: Kysely<DB>,
  { settledBefore, after, limit }: { settledBefore: Date; after: LabelCursor | null; limit: number }
): Promise<LabelBatch> {
  const afterClause = after
    ? sql`AND (v."settledAt", v."itemId", v."playerId") > (${utc(after.settledAt)}, ${
        after.itemId
      }, ${after.playerId})`
    : sql``;
  const { rows } = await sql<{
    itemId: number;
    playerId: number;
    settledAt: Date;
    written: boolean;
    done: boolean;
  }>`
    WITH batch AS (
      SELECT v."itemId", v."playerId", v."createdAt", v."settledAt", v."questionKey", v."imageId", v."answer"
      FROM "KnightsVote" v
      WHERE v."settledAt" IS NOT NULL AND NOT v."labelled"
        AND v."settledAt" <= ${utc(settledBefore)}
        ${afterClause}
        AND EXISTS (SELECT 1 FROM "KnightsQuestion" kq WHERE kq."key" = v."questionKey" AND kq."kind" = 'choice')
        AND NOT ${heldSql('v.playerId')}
      ORDER BY v."settledAt", v."itemId", v."playerId"
      LIMIT ${limit}
    ), base AS (
      SELECT b.*, i."url", i."pHash", q."version",
        i."id" IS NOT NULL AND q."key" IS NOT NULL AS "hasSubject",
        'KnightsVote:' || b."itemId" || ':' || label_store.person_hash('labeller', b."playerId") AS "ref"
      FROM batch b
      LEFT JOIN "Image" i ON i."id" = b."imageId"
      LEFT JOIN "KnightsQuestion" q ON q."key" = b."questionKey"
    ), rec AS MATERIALIZED (
      SELECT b."itemId", b."playerId", b."createdAt", b."settledAt", b."hasSubject",
        CASE WHEN b."hasSubject" THEN b."ref" END AS "ref",
        CASE WHEN b."hasSubject" THEN
          label_store.record_label(
            p_subject_type => 'image',
            p_subject_id => b."imageId"::text,
            p_content_hash => label_store.text_hash(b."url"),
            p_family => 'knights',
            p_question => b."questionKey",
            p_value => b."answer",
            p_labeller_kind => 'knight',
            p_source_ref => b."ref",
            p_labelled_at => b."createdAt" AT TIME ZONE 'UTC',
            p_labeller_user_id => b."playerId",
            p_question_version => b."version",
            p_snapshot => jsonb_build_object('url', b."url"),
            p_phash => b."pHash"
          )
        END AS "labelId"
      FROM base b
    ), outcome AS (
      SELECT r.*,
        (NOT r."hasSubject" OR r."labelId" IS NOT NULL OR EXISTS (
          SELECT 1 FROM label_store.label l WHERE l."sourceRef" = r."ref"
        )) AS "done"
      FROM rec r
    ), marked AS (
      UPDATE "KnightsVote" v SET "labelled" = true
      FROM outcome o
      WHERE o."done" AND v."itemId" = o."itemId" AND v."playerId" = o."playerId" AND v."createdAt" = o."createdAt"
      RETURNING 1
    )
    SELECT o."itemId", o."playerId", o."settledAt", (o."labelId" IS NOT NULL) AS "written", o."done"
    FROM outcome o
    ORDER BY o."settledAt", o."itemId", o."playerId"
  `.execute(db);

  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    written: rows.filter((r) => r.written).length,
    failed: rows.filter((r) => !r.done).length,
    cursor: last
      ? {
          settledAt: new Date(last.settledAt),
          itemId: Number(last.itemId),
          playerId: Number(last.playerId),
        }
      : after,
  };
}
