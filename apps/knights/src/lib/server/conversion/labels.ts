import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { utc } from '@civitai/db/kysely';
import { heldSql } from './held';

/** A vote the store has refused this many times is given up on (its reason stays in `record_failure`), so it is not retried forever. */
const MAX_REFUSALS = 5;

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

type BatchArgs = {
  settledBefore: Date;
  after: LabelCursor | null;
  limit: number;
  /** Restricts the batch to one vote (the row-by-row fallback). */
  only?: { itemId: number; playerId: number };
};

type Row = { itemId: number; playerId: number; settledAt: Date; written: boolean; done: boolean };

async function runBatch(
  db: Kysely<DB>,
  { settledBefore, after, limit, only }: BatchArgs
): Promise<Row[]> {
  const onlyClause = only
    ? sql`AND v."itemId" = ${only.itemId} AND v."playerId" = ${only.playerId}`
    : sql``;
  const afterClause = after
    ? sql`AND (v."settledAt", v."itemId", v."playerId") > (${utc(after.settledAt)}, ${
        after.itemId
      }, ${after.playerId})`
    : sql``;
  const { rows } = await sql<Row>`
    WITH batch AS (
      SELECT v."itemId", v."playerId", v."createdAt", v."settledAt", v."questionKey", v."imageId", v."answer"
      FROM "KnightsVote" v
      WHERE v."settledAt" IS NOT NULL AND NOT v."labelled"
        AND v."settledAt" <= ${utc(settledBefore)}
        ${afterClause}
        ${onlyClause}
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
        CASE
          WHEN NOT r."hasSubject" OR r."labelId" IS NOT NULL THEN true
          WHEN EXISTS (SELECT 1 FROM label_store.label l WHERE l."sourceRef" = r."ref") THEN true
          ELSE (SELECT count(*) FROM label_store.record_failure f WHERE f."sourceRef" = r."ref") >= ${MAX_REFUSALS}
        END AS "done"
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
  return rows;
}

function summarize(rows: Row[], after: LabelCursor | null, extraFailed = 0): LabelBatch {
  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    written: rows.filter((r) => r.written).length,
    failed: rows.filter((r) => !r.done).length + extraFailed,
    cursor: last
      ? {
          settledAt: new Date(last.settledAt),
          itemId: Number(last.itemId),
          playerId: Number(last.playerId),
        }
      : after,
  };
}

/** The failure of a vote whose statement raised is filed under a ref that needs no per-player hash, which is what raised. */
const raisedRef = (itemId: number, playerId: number) =>
  sql`'KnightsVoteError:' || ${itemId}::text || ':' || label_store.text_hash(${playerId}::text)`;

/**
 * When a batch raises, one bad vote would fail every pass on the same batch. Each vote is tried alone instead:
 * the one that raises is recorded as a failure, counts toward `MAX_REFUSALS`, and the others are written.
 */
async function writeRowByRow(db: Kysely<DB>, args: BatchArgs): Promise<LabelBatch> {
  const { rows: keys } = await sql<{ itemId: number; playerId: number; settledAt: Date }>`
    SELECT v."itemId", v."playerId", v."settledAt" FROM "KnightsVote" v
    WHERE v."settledAt" IS NOT NULL AND NOT v."labelled" AND v."settledAt" <= ${utc(
      args.settledBefore
    )}
      ${
        args.after
          ? sql`AND (v."settledAt", v."itemId", v."playerId") > (${utc(args.after.settledAt)}, ${
              args.after.itemId
            }, ${args.after.playerId})`
          : sql``
      }
      AND NOT ${heldSql('v.playerId')}
    ORDER BY v."settledAt", v."itemId", v."playerId"
    LIMIT ${args.limit}
  `.execute(db);
  const rows: Row[] = [];
  let raised = 0;
  for (const key of keys) {
    const only = { itemId: Number(key.itemId), playerId: Number(key.playerId) };
    const ref = raisedRef(only.itemId, only.playerId);
    const { rows: counted } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM label_store.record_failure f WHERE f."sourceRef" = ${ref}
    `.execute(db);
    if (Number(counted[0].n) >= MAX_REFUSALS) {
      await sql`UPDATE "KnightsVote" SET "labelled" = true WHERE "itemId" = ${only.itemId} AND "playerId" = ${only.playerId}`.execute(
        db
      );
      continue;
    }
    try {
      rows.push(...(await runBatch(db, { ...args, only, limit: 1 })));
    } catch (error) {
      raised++;
      await sql`SELECT label_store.note_failure(${ref}, ${String(error)})`.execute(db);
    }
  }
  const last = keys[keys.length - 1];
  return {
    ...summarize(rows, args.after, raised),
    scanned: keys.length,
    cursor: last
      ? {
          settledAt: new Date(last.settledAt),
          itemId: Number(last.itemId),
          playerId: Number(last.playerId),
        }
      : args.after,
  };
}

/**
 * One `knight` label per settled vote at or before `settledBefore`, for players not held. The store never retracts a label, so a held player's votes stay unwritten and unmarked until released.
 * The player appears in the source ref only as the store's own hash, never as a user id. A vote whose image is gone is only marked.
 */
export async function writeLabelBatch(
  db: Kysely<DB>,
  args: Omit<BatchArgs, 'only'>
): Promise<LabelBatch> {
  try {
    return summarize(await runBatch(db, args), args.after);
  } catch (error) {
    console.error('knights: a label batch raised, writing its votes one by one', { error });
    return writeRowByRow(db, args);
  }
}
