import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { utc } from '@civitai/db/kysely';
import { YESNO_KEY_PREFIX } from '../yesno/keys';
import { heldSql } from './held';

/** A vote the store has refused this many times is given up on (its reason stays in `record_failure`), so it is not retried forever. */
const MAX_REFUSALS = 5;

/** A vote the store refused, or whose write raised, is not tried again for this long, so a short outage cannot use up its refusals. */
const RETRY_AFTER_MINUTES = 10;

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
 * Gives every choice question a label-store `rule` row (`minHuman` = votes to resolve, not unanimous), and every yes/no question that has
 * been answered one under its own label question (the producer's id), so the store can compute its majority. Idempotent.
 */
export async function ensureQuestionRules(db: Kysely<DB>): Promise<void> {
  await ensureChoiceRules(db);
  await ensureYesNoRules(db);
}

export async function ensureChoiceRules(db: Kysely<DB>): Promise<void> {
  await sql`
    INSERT INTO label_store.rule ("question", "questionVersion", "minHuman", "requireUnanimous")
    SELECT q."key", q."version", q."votesToResolve", false
    FROM "KnightsQuestion" q
    WHERE q."kind" = 'choice'
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function ensureYesNoRules(db: Kysely<DB>): Promise<void> {
  await sql`
    INSERT INTO label_store.rule ("question", "questionVersion", "minHuman", "requireUnanimous")
    SELECT ${YESNO_KEY_PREFIX}::text || i."externalId", q."version", q."votesToResolve", false
    FROM "KnightsQueueItem" i
    JOIN "KnightsQuestion" q ON q."key" = i."questionKey"
    WHERE i."audience" IS NOT NULL AND i."externalId" IS NOT NULL AND i."voteCount" > 0
    ON CONFLICT DO NOTHING
  `.execute(db);
}

/**
 * Rating votes are written once graded (`settledAt`); yes/no answers are not graded, so they are written as given (`createdAt`).
 * The batch's cursor `settledAt` is that time.
 */
export type LabelKind = 'rating' | 'yesno';

type BatchArgs = {
  after: LabelCursor | null;
  limit: number;
  /** Restricts the batch to one vote (the row-by-row fallback). */
  only?: { itemId: number; playerId: number };
  kind?: LabelKind;
};

type Row = { itemId: number; playerId: number; settledAt: Date; written: boolean; done: boolean };

/** The SQL that differs between the two kinds of vote. */
function shapeOf(kind: LabelKind) {
  if (kind === 'yesno') {
    return {
      when: sql`v."createdAt"`,
      join: sql`JOIN "KnightsQueueItem" it ON it."id" = v."itemId" AND it."audience" IS NOT NULL AND it."externalId" IS NOT NULL`,
      eligible: sql`v."itemId" > 0`,
      externalId: sql`it."externalId"`,
      ref: (hash: ReturnType<typeof sql>, at: 'b' | 'source') =>
        sql`'KnightsYesNoVote:' || ${sql.ref(
          `${at === 'b' ? 'b' : 'it'}.externalId`
        )} || ':' || ${hash}`,
      question: sql`${YESNO_KEY_PREFIX}::text || b."externalId"`,
    };
  }
  return {
    when: sql`v."settledAt"`,
    join: sql``,
    eligible: sql`v."settledAt" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "KnightsQuestion" kq WHERE kq."key" = v."questionKey" AND kq."kind" = 'choice')`,
    externalId: sql`NULL::text`,
    ref: (hash: ReturnType<typeof sql>, at: 'b' | 'source') =>
      sql`'KnightsVote:' || ${sql.ref(`${at === 'b' ? 'b' : 'v'}.itemId`)} || ':' || ${hash}`,
    question: sql`b."questionKey"`,
  };
}

async function runBatch(
  db: Kysely<DB>,
  { after, limit, only, kind = 'rating' }: BatchArgs
): Promise<Row[]> {
  const shape = shapeOf(kind);
  const onlyClause = only
    ? sql`AND v."itemId" = ${only.itemId} AND v."playerId" = ${only.playerId}`
    : sql``;
  const afterClause = after
    ? sql`AND (${shape.when}, v."itemId", v."playerId") > (${utc(after.settledAt)}, ${
        after.itemId
      }, ${after.playerId})`
    : sql``;
  const { rows } = await sql<Row>`
    WITH batch AS (
      SELECT v."itemId", v."playerId", v."createdAt", ${
        shape.when
      } AS "settledAt", v."questionKey", v."imageId", v."answer",
        ${shape.externalId} AS "externalId"
      FROM "KnightsVote" v
      ${shape.join}
      WHERE NOT v."labelled"
        AND ${shape.eligible}
        ${afterClause}
        ${onlyClause}
        AND NOT ${heldSql('v.playerId')}
        AND ${notRecentlyFailed(
          shape.ref(sql`label_store.person_hash('labeller', v."playerId")`, 'source')
        )}
      ORDER BY ${shape.when}, v."itemId", v."playerId"
      LIMIT ${limit}
    ), base AS (
      SELECT b.*, i."url", i."pHash", q."version",
        i."id" IS NOT NULL AND q."key" IS NOT NULL AS "hasSubject",
        ${shape.ref(sql`label_store.person_hash('labeller', b."playerId")`, 'b')} AS "ref"
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
            p_question => ${shape.question},
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

/** Whether any vote of this kind is waiting for a label, so a quiet tick can skip the setup writes. */
export async function hasUnlabelled(db: Kysely<DB>, kind: LabelKind): Promise<boolean> {
  const shape = shapeOf(kind);
  const { rows } = await sql`
    SELECT 1 FROM "KnightsVote" v
    ${shape.join}
    WHERE NOT v."labelled" AND ${shape.eligible} AND NOT ${heldSql('v.playerId')}
    LIMIT 1
  `.execute(db);
  return rows.length > 0;
}

/** True when the store has no failure for `ref` newer than the retry age. */
const notRecentlyFailed = (ref: ReturnType<typeof sql>) =>
  sql`NOT EXISTS (SELECT 1 FROM label_store.record_failure rf WHERE rf."sourceRef" = ${ref}
    AND rf."createdAt" > now() - make_interval(mins => ${RETRY_AFTER_MINUTES}))`;

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
 * the one that raises is recorded as a failure, counts toward `MAX_REFUSALS`, and the others are written. A vote that failed within the retry age is skipped, and when every vote tried raises the store is taken to be down and none is recorded.
 */
async function writeRowByRow(db: Kysely<DB>, args: BatchArgs): Promise<LabelBatch> {
  const shape = shapeOf(args.kind ?? 'rating');
  const { rows: keys } = await sql<{ itemId: number; playerId: number; settledAt: Date }>`
    SELECT v."itemId", v."playerId", ${shape.when} AS "settledAt" FROM "KnightsVote" v
    ${shape.join}
    WHERE NOT v."labelled" AND ${shape.eligible}
      ${
        args.after
          ? sql`AND (${shape.when}, v."itemId", v."playerId") > (${utc(args.after.settledAt)}, ${
              args.after.itemId
            }, ${args.after.playerId})`
          : sql``
      }
      AND NOT ${heldSql('v.playerId')}
    ORDER BY ${shape.when}, v."itemId", v."playerId"
    LIMIT ${args.limit}
  `.execute(db);
  const rows: Row[] = [];
  const raisedVotes: { ref: ReturnType<typeof sql>; error: unknown }[] = [];
  let attempted = 0;
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
    const { rows: recent } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM label_store.record_failure f
      WHERE f."sourceRef" = ${ref} AND f."createdAt" > now() - make_interval(mins => ${RETRY_AFTER_MINUTES})
    `.execute(db);
    if (Number(recent[0].n) > 0) continue;
    attempted++;
    try {
      rows.push(...(await runBatch(db, { ...args, only, limit: 1 })));
    } catch (error) {
      raisedVotes.push({ ref, error });
    }
  }
  // When every vote tried raised, the store is down rather than the votes bad: nothing is recorded against them.
  const storeDown = attempted > 1 && raisedVotes.length === attempted;
  if (!storeDown) {
    for (const { ref, error } of raisedVotes) {
      await sql`SELECT label_store.note_failure(${ref}, ${String(error)})`.execute(db);
    }
  }
  const raised = raisedVotes.length;
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
 * One `knight` label per settled vote, for players not held. The store never retracts a label, so a held player's votes stay unwritten and unmarked until released.
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
