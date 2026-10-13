import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';

/**
 * Upkeep for "AppealDecisionRecord", the rows the `appeal_decision_record` trigger writes when an image
 * appeal is decided (see its migration). Excluded rows are deleted first, so nothing later in the run,
 * or anything that reads the table, sees them.
 */

const REMOVAL_LABEL_WINDOW_DAYS = 30;
const RESTORED_LEVEL_WINDOW_DAYS = 90;
const BATCH = 5000;

/**
 * A record that must not exist: its image is CSAM-flagged or named in a CSAM report, or its owner is.
 * The trigger applies the same rule at write time; this catches what becomes true afterwards.
 */
export const excludedRecord = (r: Prisma.Sql) => Prisma.sql`(
  EXISTS (
    SELECT 1 FROM "CsamReport" c
    WHERE c."userId" = ${r}."ownerId"
       OR c.images @> jsonb_build_array(jsonb_build_object('id', ${r}."imageId"))
  )
  OR EXISTS (SELECT 1 FROM "Image" i WHERE i.id = ${r}."imageId" AND i."needsReview" = 'csam')
)`;

export async function sweepExcludedRecords() {
  const r = Prisma.raw('r');
  return dbWrite.$executeRaw`
    DELETE FROM "AppealDecisionRecord" r WHERE ${excludedRecord(r)}
  `;
}

export type RemovalLabelLookup = (imageIds: number[]) => Promise<Map<number, string>>;

/** The label a moderator removed each image under, from its latest DeleteTOS event. */
export const removalLabelsFromClickhouse: RemovalLabelLookup = async (imageIds) => {
  if (!clickhouse || !imageIds.length) return new Map();
  const rows = await clickhouse.$query<{ imageId: number; label: string }>`
    SELECT imageId, argMax(coalesce(tosReason, violationType), time) AS label
    FROM images
    WHERE type = 'DeleteTOS' AND imageId IN (${imageIds})
    GROUP BY imageId
    HAVING label IS NOT NULL AND label != ''
  `;
  return new Map(rows.map((row) => [row.imageId, row.label]));
};

/** Rows without a removal label are retried each night for a while; ClickHouse can lag the decision. */
export async function fillRemovalLabels(lookup: RemovalLabelLookup = removalLabelsFromClickhouse) {
  const pending = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT "imageId" FROM "AppealDecisionRecord"
    WHERE "removalLabel" IS NULL
      AND "createdAt" > now() - make_interval(days => ${REMOVAL_LABEL_WINDOW_DAYS})
    ORDER BY "imageId"
    LIMIT ${BATCH}
  `;
  if (!pending.length) return 0;

  const labels = await lookup(pending.map((p) => p.imageId));
  if (!labels.size) return 0;

  return dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord" r
    SET "removalLabel" = l.label
    FROM unnest(${[...labels.keys()]}::int[], ${[...labels.values()]}::text[]) AS l("imageId", label)
    WHERE r."imageId" = l."imageId" AND r."removalLabel" IS NULL
  `;
}

const LEVEL_LABEL = Prisma.sql`CASE i."nsfwLevel"
  WHEN 1 THEN 'PG' WHEN 2 THEN 'PG13' WHEN 4 THEN 'R' WHEN 8 THEN 'X' WHEN 16 THEN 'XXX' END`;

/**
 * For approvals: records the level the image came back at, and when the image's latest rating label is
 * still Blocked, appends one that says what the appeal found. The rating-label trigger cannot do it:
 * approval unlocks the level before recomputing it, and that trigger only fires on locked rows.
 */
export async function recordRestoredLevels() {
  const corrected = await dbWrite.$executeRaw`
    WITH restored AS (
      SELECT r.id, r."imageUrl", ${LEVEL_LABEL} AS label
      FROM "AppealDecisionRecord" r
      JOIN "Image" i ON i.id = r."imageId"
      WHERE r.decision = 'Approved'
        AND r."restoredLevel" IS NULL
        AND r."decidedAt" > now() - make_interval(days => ${RESTORED_LEVEL_WINDOW_DAYS})
        AND i.ingestion = 'Scanned'
        AND i."nsfwLevel" IN (1, 2, 4, 8, 16)
    ),
    latest AS (
      SELECT DISTINCT ON (tl.url) tl.url, tl.label
      FROM training_labels tl
      WHERE tl.url IN (SELECT "imageUrl" FROM restored)
      ORDER BY tl.url, tl."createdAt" DESC
    ),
    inserted AS (
      INSERT INTO training_labels (url, label, "createdAt", source, reason, old_label)
      SELECT rs."imageUrl", rs.label, now(), 'appeal', 'Appeal approved', 'Blocked'
      FROM restored rs
      JOIN latest l ON l.url = rs."imageUrl" AND l.label = 'Blocked'
      RETURNING url
    )
    UPDATE "AppealDecisionRecord" r
    SET "trainingLabelCorrectedAt" = now()
    FROM restored rs
    WHERE r.id = rs.id AND rs."imageUrl" IN (SELECT url FROM inserted)
  `;

  const restored = await dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord" r
    SET "restoredLevel" = i."nsfwLevel"
    FROM "Image" i
    WHERE i.id = r."imageId"
      AND r.decision = 'Approved'
      AND r."restoredLevel" IS NULL
      AND r."decidedAt" > now() - make_interval(days => ${RESTORED_LEVEL_WINDOW_DAYS})
      AND i.ingestion = 'Scanned'
      AND i."nsfwLevel" IN (1, 2, 4, 8, 16)
  `;

  return { restored, corrected };
}

export const appealDecisionRecordsJob = createJob(
  'appeal-decision-records',
  '40 4 * * *',
  async () => {
    const swept = await sweepExcludedRecords();
    const labelled = await fillRemovalLabels();
    const { restored, corrected } = await recordRestoredLevels();
    return { swept, labelled, restored, corrected };
  }
);
