import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';

/** Upkeep for "AppealDecisionRecord" (see the `appeal_decision_record` trigger migration). */

// Inlined, not bound: Prisma binds numbers as int8 and make_interval only takes int4.
const REMOVAL_LABEL_WINDOW = Prisma.raw(`make_interval(days => 30)`);
const RESTORED_LEVEL_WINDOW = Prisma.raw(`make_interval(days => 90)`);
const RECORD_RETENTION = Prisma.raw(`make_interval(years => 2)`);
const BATCH = 5000;

// Written by this job; the sweep removes them with the record they came from.
const CORRECTION_SOURCE = 'appeal';

/** Must match the exclusion in the `appeal_decision_record` trigger; edit both together. */
export const excludedRecord = (r: Prisma.Sql) => Prisma.sql`(
  ${r}."blockedFor" IS NOT DISTINCT FROM 'CSAM'
  OR ${r}."imageId" IN (
    SELECT (e->>'id')::int
    FROM "CsamReport" c, jsonb_array_elements(c.images) e
    WHERE jsonb_typeof(c.images) = 'array' AND jsonb_typeof(e->'id') = 'number'
  )
  OR EXISTS (
    SELECT 1 FROM "Image" ex
    WHERE ex.id = ${r}."imageId"
      AND (
        ex."needsReview" = 'csam'
        OR ex."blockedFor" = 'CSAM'
        OR ex."userId" IN (SELECT c."userId" FROM "CsamReport" c WHERE c."userId" IS NOT NULL)
      )
  )
)`;

/** Deletes excluded records, the training labels this job derived from them, and expired records. */
export async function sweepExcludedRecords() {
  const r = Prisma.raw('r');
  const [{ swept }] = await dbWrite.$queryRaw<{ swept: number }[]>`
    WITH removed AS (
      DELETE FROM "AppealDecisionRecord" r WHERE ${excludedRecord(r)}
      RETURNING r."imageUrl"
    ),
    labels AS (
      DELETE FROM training_labels tl
      WHERE tl.source = ${CORRECTION_SOURCE} AND tl.url IN (SELECT "imageUrl" FROM removed)
    )
    SELECT count(*)::int AS swept FROM removed
  `;
  const expired = await dbWrite.$executeRaw`
    DELETE FROM "AppealDecisionRecord" WHERE "createdAt" < now() - ${RECORD_RETENTION}
  `;
  return { swept, expired };
}

export type RemovalLabelLookup = (imageIds: number[]) => Promise<Map<number, string>>;

/** The violation each image was removed for, from its latest DeleteTOS event. */
export const removalLabelsFromClickhouse: RemovalLabelLookup = async (imageIds) => {
  if (!clickhouse || !imageIds.length) return new Map();
  const rows = await clickhouse.$query<{ imageId: number; label: string }>`
    SELECT imageId, argMax(coalesce(nullIf(violationType, ''), tosReason), time) AS label
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
      AND "createdAt" > now() - ${REMOVAL_LABEL_WINDOW}
    ORDER BY "imageId"
    LIMIT ${BATCH}
  `;
  if (!pending.length) return 0;

  const labels = await lookup(pending.map((p) => p.imageId));
  if (!labels.size) return 0;

  return dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord" r
    SET "removalLabel" = l.label
    FROM unnest(${[...labels.keys()]}::int[], ${[
    ...labels.values(),
  ]}::text[]) AS l("imageId", label)
    WHERE r."imageId" = l."imageId" AND r."removalLabel" IS NULL
  `;
}

// The spellings `training_labels` already uses, which differ from the browsing-level labels.
const LEVEL_LABEL = Prisma.sql`CASE i."nsfwLevel"
  WHEN 1 THEN 'PG' WHEN 2 THEN 'PG13' WHEN 4 THEN 'R' WHEN 8 THEN 'X' WHEN 16 THEN 'XXX' END`;

const restoredApproval = (r: Prisma.Sql) => Prisma.sql`
  ${r}.decision = 'Approved'
  AND ${r}."restoredLevel" IS NULL
  AND ${r}."decidedAt" > now() - ${RESTORED_LEVEL_WINDOW}
  AND i.ingestion = 'Scanned'
  AND i."nsfwLevel" IN (1, 2, 4, 8, 16)
  AND NOT ${excludedRecord(r)}
`;

/**
 * For approvals: records the level the image came back at, and appends a training label with it when
 * the image's latest one still says Blocked.
 */
export async function recordRestoredLevels() {
  const r = Prisma.raw('r');
  const corrected = await dbWrite.$executeRaw`
    WITH restored AS (
      SELECT r.id, r."imageUrl", ${LEVEL_LABEL} AS label
      FROM "AppealDecisionRecord" r
      JOIN "Image" i ON i.id = r."imageId"
      WHERE ${restoredApproval(r)}
    ),
    latest AS (
      SELECT DISTINCT ON (tl.url) tl.url, tl.label
      FROM training_labels tl
      WHERE tl.url IN (SELECT "imageUrl" FROM restored)
      ORDER BY tl.url, tl."createdAt" DESC
    ),
    inserted AS (
      INSERT INTO training_labels (url, label, "createdAt", source, reason, old_label)
      SELECT DISTINCT ON (rs."imageUrl") rs."imageUrl", rs.label, now(), ${CORRECTION_SOURCE},
        'Appeal approved', 'Blocked'
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
    WHERE i.id = r."imageId" AND ${restoredApproval(r)}
  `;

  return { restored, corrected };
}

export async function runAppealDecisionRecords(lookup?: RemovalLabelLookup) {
  const { swept, expired } = await sweepExcludedRecords();
  const labelled = await fillRemovalLabels(lookup);
  const { restored, corrected } = await recordRestoredLevels();
  return { swept, expired, labelled, restored, corrected };
}

export const appealDecisionRecordsJob = createJob('appeal-decision-records', '40 4 * * *', () =>
  runAppealDecisionRecords()
);
