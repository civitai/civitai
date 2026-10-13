import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { instrumentB2Client } from '~/server/prom/b2-put.metrics';
import { createJob } from './job';

/** Upkeep for "AppealDecisionRecord" (see the `appeal_decision_record` trigger migration). */

// Inlined, not bound: Prisma binds numbers as int8 and make_interval only takes int4.
const REMOVAL_LABEL_WINDOW = Prisma.raw(`make_interval(days => 30)`);
const RESTORED_LEVEL_WINDOW = Prisma.raw(`make_interval(days => 90)`);
const RECORD_RETENTION = Prisma.raw(`make_interval(years => 2)`);
const BATCH = 5000;

// Training labels this job appends; the sweep removes any whose image becomes excluded.
const CORRECTION_SOURCE = 'appeal';

const reportNamesImage = (imageId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "CsamReport" c
  WHERE c.images @> jsonb_build_array(jsonb_build_object('id', ${imageId}))
)`;

/** An excluded image, judged on its live row. */
const excludedImageRow = (i: Prisma.Sql) => Prisma.sql`(
  ${i}."needsReview" = 'csam'
  OR ${i}."blockedFor" = 'CSAM'
  OR ${i}."userId" IN (SELECT c."userId" FROM "CsamReport" c WHERE c."userId" IS NOT NULL)
  OR ${reportNamesImage(Prisma.sql`${i}.id`)}
)`;

/** Must match the exclusion in the `appeal_decision_record` trigger; edit both together. */
export const excludedRecord = (r: Prisma.Sql) => Prisma.sql`(
  ${r}."blockedFor" IS NOT DISTINCT FROM 'CSAM'
  OR ${reportNamesImage(Prisma.sql`${r}."imageId"`)}
  OR EXISTS (
    SELECT 1 FROM "Image" ex WHERE ex.id = ${r}."imageId" AND ${excludedImageRow(Prisma.raw('ex'))}
  )
)`;

/**
 * Deletes excluded records, the training labels this job wrote for any excluded image (with or without
 * a record), and expired records.
 */
export async function sweepExcludedRecords(store?: AppealTrainingStore | null) {
  const r = Prisma.raw('r');
  const [{ swept, labels, keys }] = await dbWrite.$queryRaw<
    { swept: number; labels: number; keys: string[] }[]
  >`
    WITH removed AS (
      DELETE FROM "AppealDecisionRecord" r WHERE ${excludedRecord(r)}
      RETURNING r."imageUrl", r."trainingObjectKey"
    ),
    labels AS (
      DELETE FROM training_labels tl
      WHERE tl.source = ${CORRECTION_SOURCE}
        AND (
          tl.url IN (SELECT "imageUrl" FROM removed)
          OR EXISTS (
            SELECT 1 FROM "Image" li WHERE li.url = tl.url AND ${excludedImageRow(Prisma.raw('li'))}
          )
        )
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM removed)::int AS swept, (SELECT count(*) FROM labels)::int AS labels,
      ARRAY(SELECT "trainingObjectKey" FROM removed WHERE "trainingObjectKey" IS NOT NULL) AS keys
  `;
  const expiredRows = await dbWrite.$queryRaw<{ key: string | null }[]>`
    DELETE FROM "AppealDecisionRecord" WHERE "createdAt" < now() - ${RECORD_RETENTION}
    RETURNING "trainingObjectKey" AS key
  `;
  const objects = await removeTrainingObjects(store, keys, expiredRows);
  return { swept, labels, expired: expiredRows.length, objects };
}

// Runs after the records are gone, so a bucket failure never keeps a record.
async function removeTrainingObjects(
  store: AppealTrainingStore | null | undefined,
  sweptKeys: string[],
  expiredRows: { key: string | null }[]
) {
  const keys = [...sweptKeys, ...expiredRows.flatMap((row) => (row.key ? [row.key] : []))];
  if (!keys.length) return 0;
  try {
    store ??= await appealTrainingStoreFromEnv();
    if (!store) throw new Error('training bucket not configured');
    await store.remove(keys);
    return keys.length;
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: JOB_LOG_NAME,
      message: 'Could not delete training objects for removed records',
      details: { keys, error: (e as Error).message },
    });
    return 0;
  }
}

export type Removal = { label: string; nsfw: string | null };
export type RemovalLabelLookup = (imageIds: number[]) => Promise<Map<number, Removal>>;

/** The violation each image was removed for, and its rating then, from its latest DeleteTOS event. */
export const removalLabelsFromClickhouse: RemovalLabelLookup = async (imageIds) => {
  if (!clickhouse || !imageIds.length) return new Map();
  const rows = await clickhouse.$query<{ imageId: number; label: string; nsfw: string | null }>`
    SELECT imageId, argMax(coalesce(nullIf(violationType, ''), tosReason), time) AS label,
      argMax(toString(nsfw), time) AS nsfw
    FROM images
    WHERE type = 'DeleteTOS' AND imageId IN (${imageIds})
    GROUP BY imageId
    HAVING label IS NOT NULL AND label != ''
  `;
  return new Map(rows.map((row) => [row.imageId, { label: row.label, nsfw: row.nsfw || null }]));
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

  return storeRemovalLabels(await lookup(pending.map((p) => p.imageId)));
}

async function storeRemovalLabels(removals: Map<number, Removal>) {
  if (!removals.size) return 0;
  const ids = [...removals.keys()];
  const labels = [...removals.values()].map((v) => v.label);
  const ratings = [...removals.values()].map((v) => v.nsfw);
  return dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord" r
    SET "removalLabel" = l.label, "removalNsfw" = l.nsfw
    FROM unnest(${ids}::int[], ${labels}::text[], ${ratings}::text[]) AS l("imageId", label, nsfw)
    WHERE r."imageId" = l."imageId" AND r."removalLabel" IS NULL
  `;
}

const JOB_LOG_NAME = 'appeal-training-copy';
const COPY_WINDOW = Prisma.raw(`make_interval(hours => 24)`);
const UNLABELLED_HOLD = Prisma.raw(`make_interval(hours => 1)`);
const COPY_BATCH = 200;

const NEVER_COPY_LABELS = [
  'minor',
  'animatedMinorNsfw',
  'realisticMinorNsfw',
  'realisticMinor',
  'schoolNsfw',
  'minorViolence',
  'diaper',
  'realPersonNsfw',
  'non-ai',
];
const RATED_COPY_LABELS = ['poi', 'realPerson'];

// NULL-safe: an unknown rating counts as never-copy.
const neverCopy = (r: Prisma.Sql) => Prisma.sql`(
  ${r}."removalLabel" = ANY(${NEVER_COPY_LABELS}::text[])
  OR ${r}."removalLabel" ILIKE '%minor%'
  OR (
    ${r}."removalLabel" = ANY(${RATED_COPY_LABELS}::text[])
    AND NOT coalesce(
      ${r}."removalNsfw" IN ('None', 'Soft') AND coalesce(${r}."aiNsfwLevel", 0) IN (0, 1, 2),
      false
    )
  )
)`;

const pendingCopy = (r: Prisma.Sql) =>
  Prisma.sql`${r}.decision = 'Rejected' AND ${r}."trainingCopyState" IS NULL`;

/**
 * Keeps `remove-blocked-images` off an image until the copy job has had its chance. Only valid inside
 * a statement where `i` names an "Image" row.
 */
export const appealTrainingHeld = (i: Prisma.Sql) => {
  const h = Prisma.raw('h');
  const copyable = Prisma.sql`NOT ${neverCopy(h)}`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "AppealDecisionRecord" h
    WHERE h."imageId" = ${i}.id
      AND ${pendingCopy(h)}
      AND CASE
        WHEN h."removalLabel" IS NULL THEN h."decidedAt" > now() - ${UNLABELLED_HOLD}
        ELSE h."decidedAt" > now() - ${COPY_WINDOW} AND ${copyable}
      END
      AND NOT ${excludedRecord(h)}
  )`;
};

export type AppealTrainingStore = {
  /** Copies the original stored under `imageUrl` and returns the training object's key. */
  copy: (imageUrl: string) => Promise<string>;
  remove: (keys: string[]) => Promise<void>;
};

export function createAppealTrainingStore({
  source,
  sourceBucket,
  target,
  targetBucket,
}: {
  source: S3Client;
  sourceBucket: string;
  target: S3Client;
  targetBucket: string;
}): AppealTrainingStore {
  return {
    async copy(imageUrl) {
      const original = await source.send(
        new GetObjectCommand({ Bucket: sourceBucket, Key: imageUrl })
      );
      await target.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key: imageUrl,
          Body: original.Body,
          ContentType: original.ContentType,
          ContentLength: original.ContentLength,
        })
      );
      return imageUrl;
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const { Errors } = await target.send(
          new DeleteObjectsCommand({
            Bucket: targetBucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          })
        );
        if (Errors?.length)
          throw new Error(`delete failed: ${Errors.map((e) => e.Key).join(', ')}`);
      }
    },
  };
}

function appealTrainingConfig() {
  const bucket = env.APPEAL_TRAINING_B2_BUCKET;
  const accessKeyId = env.APPEAL_TRAINING_B2_ACCESS_KEY;
  const secretAccessKey = env.APPEAL_TRAINING_B2_SECRET_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const endpoint = env.S3_IMAGE_B2_ENDPOINT;
  if (!endpoint || !env.S3_IMAGE_B2_ACCESS_KEY || !env.S3_IMAGE_B2_SECRET_KEY) return null;
  return { bucket, accessKeyId, secretAccessKey, endpoint };
}

/** Whether the copy job can run; when it cannot, nothing is held for it. */
export const isAppealTrainingConfigured = () => appealTrainingConfig() !== null;

export async function appealTrainingStoreFromEnv(): Promise<AppealTrainingStore | null> {
  const config = appealTrainingConfig();
  if (!config) return null;
  const { bucket, accessKeyId, secretAccessKey, endpoint } = config;
  // Imported here: s3-utils reads upload env at load, which this module's importers need not have.
  const { getImageUploadBackend } = await import('~/utils/s3-utils');
  const { s3, bucket: sourceBucket } = await getImageUploadBackend();
  return createAppealTrainingStore({
    source: s3,
    sourceBucket,
    target: instrumentB2Client(
      new S3Client({
        credentials: { accessKeyId, secretAccessKey },
        region: env.S3_IMAGE_B2_REGION ?? 'us-west-004',
        endpoint,
        forcePathStyle: true,
      })
    ),
    targetBucket: bucket,
  });
}

/**
 * Copies the originals of rejected appeals into the training bucket before `remove-blocked-images`
 * purges them. A record ends copied, skipped or failed; one with no removal label yet waits for it.
 */
export async function copyRejectedForTraining({
  store,
  lookup = removalLabelsFromClickhouse,
}: { store?: AppealTrainingStore | null; lookup?: RemovalLabelLookup } = {}) {
  if (store === undefined) store = await appealTrainingStoreFromEnv();
  if (!store) {
    logToAxiom({
      type: 'warning',
      name: JOB_LOG_NAME,
      message: 'Training bucket not configured; nothing copied',
    });
    return { configured: false };
  }

  const r = Prisma.raw('r');
  const unlabelled = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT DISTINCT "imageId" FROM "AppealDecisionRecord" r
    WHERE ${pendingCopy(r)} AND "removalLabel" IS NULL AND "decidedAt" > now() - ${COPY_WINDOW}
    ORDER BY "imageId"
    LIMIT ${COPY_BATCH}
  `;
  const labelled = unlabelled.length
    ? await storeRemovalLabels(await lookup(unlabelled.map((u) => u.imageId)))
    : 0;

  const pending = await dbWrite.$queryRaw<
    { appealId: number; imageUrl: string; action: 'copy' | 'skip' | 'wait' }[]
  >`
    SELECT r."appealId", r."imageUrl",
      CASE
        WHEN r."decidedAt" <= now() - ${COPY_WINDOW}
          OR NOT EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = r."imageId")
          OR ${excludedRecord(r)}
          THEN 'skip'
        WHEN r."removalLabel" IS NULL THEN 'wait'
        WHEN ${neverCopy(r)} THEN 'skip'
        ELSE 'copy'
      END AS action
    FROM "AppealDecisionRecord" r
    WHERE ${pendingCopy(r)}
    ORDER BY r."decidedAt"
    LIMIT ${COPY_BATCH}
  `;

  const skipIds = pending.filter((p) => p.action === 'skip').map((p) => p.appealId);
  if (skipIds.length) await setCopyState(skipIds, 'skipped');

  let copied = 0;
  let failed = 0;
  for (const { appealId, imageUrl } of pending.filter((p) => p.action === 'copy')) {
    try {
      const key = await store.copy(imageUrl);
      await setCopyState([appealId], 'copied', key);
      copied++;
    } catch (e) {
      await setCopyState([appealId], 'failed');
      failed++;
      logToAxiom({
        type: 'error',
        name: JOB_LOG_NAME,
        message: 'Training copy failed',
        details: { appealId, error: (e as Error).message },
      });
    }
  }

  return { configured: true, labelled, copied, skipped: skipIds.length, failed };
}

function setCopyState(appealIds: number[], state: string, key: string | null = null) {
  return dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord"
    SET "trainingCopyState" = ${state}, "trainingObjectKey" = ${key}
    WHERE "appealId" = ANY(${appealIds}::int[]) AND "trainingCopyState" IS NULL
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
  const { swept, labels, expired, objects } = await sweepExcludedRecords();
  const labelled = await fillRemovalLabels(lookup);
  const { restored, corrected } = await recordRestoredLevels();
  return { swept, labels, expired, objects, labelled, restored, corrected };
}

export const appealDecisionRecordsJob = createJob('appeal-decision-records', '40 4 * * *', () =>
  runAppealDecisionRecords()
);

export const appealTrainingCopyJob = createJob('appeal-training-copy', '*/10 * * * *', () =>
  copyRejectedForTraining()
);
