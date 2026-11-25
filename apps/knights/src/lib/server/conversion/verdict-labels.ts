import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { utc } from '@civitai/db/kysely';
import { logGaveUp, MAX_REFUSALS, notRecentlyFailed, type LabelLog } from './labels';

/**
 * The label-store question the Knights verdict is recorded under: the rating question every labeller of an image's rating
 * shares, told apart by `labellerKind`.
 */
export const VERDICT_QUESTION = 'image.rating';
export const VERDICT_QUESTION_VERSION = 1;
/** The verdict is the panel's, not one player's: every verdict carries this one labeller ref, so the latest verdict wins. */
export const VERDICT_LABELLER_REF = 'knights:verdict';

export type VerdictLabelConfig = { enabled: boolean; cap?: number };

/** The most verdicts one pass takes; the env can only lower it. */
export const VERDICT_LABEL_CAP = 500;

const ON_VALUES = ['true', '1', 'yes', 'on'];

/**
 * `KNIGHTS_VERDICT_LABELS` switches verdict labels on (off when unset or anything else); `KNIGHTS_VERDICT_LABEL_CAP` lowers
 * the verdicts one pass takes (labelled or not) below `VERDICT_LABEL_CAP`. A cap that is set but is not a whole number
 * above 0 keeps the switch off.
 */
export function verdictLabelConfig(env: Record<string, string | undefined>): VerdictLabelConfig {
  if (!ON_VALUES.includes((env.KNIGHTS_VERDICT_LABELS ?? '').trim().toLowerCase()))
    return { enabled: false };
  const raw = env.KNIGHTS_VERDICT_LABEL_CAP?.trim();
  if (!raw) return { enabled: true, cap: VERDICT_LABEL_CAP };
  const cap = Number(raw);
  return Number.isInteger(cap) && cap > 0
    ? { enabled: true, cap: Math.min(cap, VERDICT_LABEL_CAP) }
    : { enabled: false };
}

export async function ensureVerdictRule(db: Kysely<DB>): Promise<void> {
  await sql`
    INSERT INTO label_store.rule ("question", "questionVersion", "minHuman", "requireUnanimous")
    VALUES (${VERDICT_QUESTION}, ${VERDICT_QUESTION_VERSION}, 1, false)
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export type VerdictCursor = { resolvedAt: Date; itemId: number };
export type VerdictBatch = {
  scanned: number;
  written: number;
  /** Verdicts not labelled because the image gate does not call their image servable. */
  excluded: number;
  /** Verdicts the store refused; they stay unmarked and a later pass retries them. */
  failed: number;
  cursor: VerdictCursor | null;
};

type Row = {
  itemId: number;
  resolvedAt: Date;
  written: boolean;
  excluded: boolean;
  done: boolean;
  gaveUp: boolean;
};

/**
 * A final rating verdict (written back to the image, so the write-back can no longer reroute it) whose label is not done
 * yet, or whose value changed since. Matches the partial index.
 */
const pending = sql`i."status" = 'Resolved' AND i."appliedAt" IS NOT NULL
  AND i."verdictLabelledValue" IS DISTINCT FROM i."resolvedValue"
  AND NOT i."isHiddenCheck" AND i."resolvedValue" IS NOT NULL AND i."resolvedAt" IS NOT NULL`;

const refOf = (alias: 'i' | 'b') =>
  sql`'KnightsVerdict:' || ${sql.ref(`${alias}.id`)}::text || ':' || ${sql.ref(
    `${alias}.resolvedValue`
  )}`;

/**
 * One `knight` label per settled verdict of the rating question, ref `KnightsVerdict:<itemId>:<value>`. Only an image
 * "KnightsImageGate" calls servable at write time is labelled: the gate is the role's only view of CSAM and hold state, so
 * anything it keeps out (for any reason) gets no label, and a gate read that raises writes nothing. An item is marked
 * with the value it was settled on once that value is recorded, refused for good, excluded, or its image is gone.
 */
export async function writeVerdictBatch(
  db: Kysely<DB>,
  { after, limit, log }: { after: VerdictCursor | null; limit: number; log?: LabelLog }
): Promise<VerdictBatch> {
  const afterClause = after
    ? sql`AND (i."resolvedAt", i."id") > (${utc(after.resolvedAt)}, ${after.itemId})`
    : sql``;
  const { rows } = await sql<Row & { ref: string }>`
    WITH batch AS (
      SELECT i."id", i."imageId", i."resolvedValue", i."resolvedAt", q."key" AS "questionKey", q."version"
      FROM "KnightsQueueItem" i
      JOIN "KnightsQuestion" q ON q."key" = i."questionKey" AND q."kind" = 'choice'
      WHERE ${pending}
        ${afterClause}
        AND ${notRecentlyFailed(refOf('i'))}
      ORDER BY i."resolvedAt", i."id"
      LIMIT ${limit}
    ), base AS (
      SELECT b.*, ${refOf('b')} AS "ref", m."url", m."pHash", m."id" IS NOT NULL AS "hasImage",
        m."id" IS NOT NULL AND NOT coalesce(g."servable", false) AS "excluded"
      FROM batch b
      LEFT JOIN "Image" m ON m."id" = b."imageId"
      LEFT JOIN "KnightsImageGate" g ON g."imageId" = b."imageId"
    ), rec AS MATERIALIZED (
      SELECT b.*,
        CASE WHEN b."hasImage" AND NOT b."excluded"
          AND (SELECT count(*) FROM label_store.record_failure f WHERE f."sourceRef" = b."ref") < ${MAX_REFUSALS} THEN
          label_store.record_label(
            p_subject_type => 'image',
            p_subject_id => b."imageId"::text,
            p_content_hash => label_store.text_hash(b."url"),
            p_family => 'knights',
            p_question => ${VERDICT_QUESTION},
            p_value => b."resolvedValue",
            p_labeller_kind => 'knight',
            p_source_ref => b."ref",
            p_labelled_at => b."resolvedAt" AT TIME ZONE 'UTC',
            p_labeller_ref => ${VERDICT_LABELLER_REF},
            p_question_version => ${VERDICT_QUESTION_VERSION}::integer,
            p_snapshot => jsonb_build_object(
              'url', b."url", 'knightsQuestion', b."questionKey", 'knightsQuestionVersion', b."version"
            ),
            p_phash => b."pHash"
          )
        END AS "labelId"
      FROM base b
    ), outcome AS (
      SELECT r.*,
        CASE
          WHEN NOT r."hasImage" OR r."excluded" OR r."labelId" IS NOT NULL THEN true
          WHEN EXISTS (SELECT 1 FROM label_store.label l WHERE l."sourceRef" = r."ref") THEN true
          ELSE (SELECT count(*) FROM label_store.record_failure f WHERE f."sourceRef" = r."ref") >= ${MAX_REFUSALS}
        END AS "done"
      FROM rec r
    ), verdict AS (
      SELECT o.*,
        o."done" AND o."hasImage" AND NOT o."excluded" AND o."labelId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM label_store.label l WHERE l."sourceRef" = o."ref") AS "gaveUp"
      FROM outcome o
    ), marked AS (
      UPDATE "KnightsQueueItem" i SET "verdictLabelledValue" = o."resolvedValue"
      FROM verdict o
      WHERE o."done" AND i."id" = o."id" AND i."resolvedValue" = o."resolvedValue"
      RETURNING 1
    )
    SELECT o."id" AS "itemId", o."resolvedAt", (o."labelId" IS NOT NULL) AS "written", o."excluded", o."done", o."gaveUp", o."ref"
    FROM verdict o
    ORDER BY o."resolvedAt", o."id"
  `.execute(db);
  for (const r of rows) if (r.gaveUp) await logGaveUp(log, 'verdict', Number(r.itemId), null);
  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    written: rows.filter((r) => r.written).length,
    excluded: rows.filter((r) => r.excluded).length,
    failed: rows.filter((r) => !r.done).length,
    cursor: last ? { resolvedAt: new Date(last.resolvedAt), itemId: Number(last.itemId) } : after,
  };
}
