import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { heldSql } from './balance';

export type LabelCursor = { settledAt: Date; itemId: number; playerId: number };
export type LabelBatch = {
  scanned: number;
  /** Labels this batch added; a vote whose label already existed counts as scanned only. */
  written: number;
  /** Votes the label store would not take; they stay unlabelled and the next pass retries them. */
  failed: number;
  cursor: LabelCursor | null;
};

/**
 * Gives every choice question a `rule` row in the label store, so its judgements can become trainable. The
 * rule asks for as many humans as the question needs to resolve, with no unanimity (the game resolves on a
 * weighted share). Yes/no questions get theirs with the task that writes their labels. Idempotent.
 */
export async function ensureQuestionRules(db: Kysely<DB>): Promise<void> {
  await sql`
    INSERT INTO label_store.rule ("question", "questionVersion", "minHuman", "requireUnanimous")
    SELECT q."key", q."version", q."votesToResolve", false
    FROM "KnightsQuestion" q
    WHERE q."kind" = 'choice'
    ON CONFLICT DO NOTHING
  `.execute(db);
}

const ts = (date: Date) => sql`${date.toISOString()}::timestamp`;

/**
 * Writes one `knight` label per settled vote, for votes settled at or before `settledBefore` (a completed
 * detection run) whose player is not held. The label store never retracts a label, so a held player's votes
 * stay unwritten, and unmarked, until the player is released.
 *
 * Idempotent twice over: the source ref is unique per vote (the player appears only as the store's own hash,
 * never as a user id), and `labelled` is set in the same statement. A vote whose image is gone has no subject
 * to write and is only marked. Only choice questions are written; yes/no questions are a later task.
 */
export async function writeLabelBatch(
  db: Kysely<DB>,
  { settledBefore, after, limit }: { settledBefore: Date; after: LabelCursor | null; limit: number }
): Promise<LabelBatch> {
  const afterClause = after
    ? sql`AND (v."settledAt", v."itemId", v."playerId") > (${ts(after.settledAt)}, ${
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
        AND v."settledAt" <= ${ts(settledBefore)}
        ${afterClause}
        AND EXISTS (SELECT 1 FROM "KnightsQuestion" kq WHERE kq."key" = v."questionKey" AND kq."kind" = 'choice')
        AND NOT ${heldSql('v.playerId')}
      ORDER BY v."settledAt", v."itemId", v."playerId"
      LIMIT ${limit}
    ), rec AS MATERIALIZED (
      SELECT b."itemId", b."playerId", b."createdAt", b."settledAt", b."imageId", b."questionKey",
        i."id" IS NOT NULL AND q."key" IS NOT NULL AS "hasSubject",
        CASE WHEN i."id" IS NOT NULL AND q."key" IS NOT NULL THEN
          'KnightsVote:' || b."itemId" || ':' || label_store.person_hash('labeller', b."playerId")
        END AS "ref",
        CASE WHEN i."id" IS NOT NULL AND q."key" IS NOT NULL THEN
          label_store.record_label(
            p_subject_type => 'image',
            p_subject_id => b."imageId"::text,
            p_content_hash => label_store.text_hash(i."url"),
            p_family => 'knights',
            p_question => q."key",
            p_value => b."answer",
            p_labeller_kind => 'knight',
            p_source_ref => 'KnightsVote:' || b."itemId" || ':' || label_store.person_hash('labeller', b."playerId"),
            p_labelled_at => b."createdAt" AT TIME ZONE 'UTC',
            p_labeller_user_id => b."playerId",
            p_question_version => q."version",
            p_snapshot => jsonb_build_object('url', i."url"),
            p_phash => i."pHash"
          )
        END AS "labelId"
      FROM batch b
      LEFT JOIN "Image" i ON i."id" = b."imageId"
      LEFT JOIN "KnightsQuestion" q ON q."key" = b."questionKey"
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
