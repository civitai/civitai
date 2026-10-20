import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { ViolationType } from '~/server/common/enums';
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

/**
 * An excluded image, judged on its live row. Restated in sweepLabelStore and in
 * `label_store.image_excluded` (label store migration); edit all three together.
 */
export const excludedImageRow = (i: Prisma.Sql) => Prisma.sql`(
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

/** Also excludes a record whose stored object is shared with an excluded image. */
const ineligibleRecord = (r: Prisma.Sql) => {
  const so = Prisma.raw('so');
  return Prisma.sql`(
    ${excludedRecord(r)}
    OR EXISTS (SELECT 1 FROM "Image" so WHERE so.url = ${r}."imageUrl" AND ${excludedImageRow(so)})
  )`;
};

/**
 * Deletes ineligible records, the training labels this job wrote for any excluded image (with or
 * without a record), and expired records, then their training objects.
 */
export async function sweepExcludedRecords(store?: AppealTrainingStore | null) {
  const r = Prisma.raw('r');
  const reportedOwners = await reportedOwnerHashes();
  const [{ swept, labels, keys }] = await dbWrite.$queryRaw<
    { swept: number; labels: number; keys: string[] }[]
  >`
    WITH removed AS (
      DELETE FROM "AppealDecisionRecord" r
      WHERE ${ineligibleRecord(r)} OR r."ownerHash" = ANY(${reportedOwners}::text[])
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
  // A key a record holds is not orphaned; a recent one may belong to a copy still running.
  await dbWrite.$executeRaw`
    DELETE FROM "AppealTrainingObjectDeletion" t
    WHERE EXISTS (SELECT 1 FROM "AppealDecisionRecord" k WHERE k."trainingObjectKey" = t.key)
  `;
  const retries = await dbWrite.$queryRaw<{ key: string }[]>`
    SELECT key FROM "AppealTrainingObjectDeletion" WHERE "createdAt" < now() - ${ORPHAN_GRACE}
  `;
  const objects = await discardTrainingObjects(store, [
    ...keys,
    ...expiredRows.flatMap((row) => (row.key ? [row.key] : [])),
    ...retries.map((row) => row.key),
  ]);
  return { swept, labels, expired: expiredRows.length, objects };
}

/**
 * Takes the label store's subjects of excluded images out of training, by the rule the records use,
 * and drops the stored text of models deleted since they were judged. Inert until the label store
 * migration is applied.
 */
export async function sweepLabelStore() {
  const [{ present }] = await dbWrite.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('label_store.subject') IS NOT NULL AS present
  `;
  if (!present) return 0;
  // excludedImageRow's rule (also label_store.image_excluded), with the report sets read once: per
  // subject, it scans CsamReport twice.
  const [{ excluded }] = await dbWrite.$queryRaw<{ excluded: number }[]>`
    WITH reported_images AS (
      SELECT DISTINCT e->>'id' AS id
      FROM "CsamReport" c,
        jsonb_array_elements(CASE WHEN jsonb_typeof(c.images) = 'array' THEN c.images ELSE '[]' END) e
    ),
    reported_users AS (
      SELECT DISTINCT c."userId" FROM "CsamReport" c WHERE c."userId" IS NOT NULL
    ),
    subjects AS (
      SELECT s."subjectId", s."ownerHash", s.snapshot->>'url' AS url,
        CASE WHEN s."subjectId" ~ '^[0-9]{1,10}$' AND s."subjectId"::bigint <= 2147483647
          THEN s."subjectId"::int END AS "imageId"
      FROM label_store.subject s
      WHERE s."subjectType" = 'image' AND s."excludedAt" IS NULL
    ),
    hit AS (
      SELECT DISTINCT s."subjectId"
      FROM subjects s
      WHERE s."subjectId" IN (SELECT id FROM reported_images)
        OR s."ownerHash" IN (SELECT label_store.person_hash('owner', "userId") FROM reported_users)
        OR EXISTS (
          SELECT 1 FROM "Image" li
          WHERE li.id = s."imageId"
            AND (li."needsReview" = 'csam' OR li."blockedFor" = 'CSAM'
              OR li."userId" IN (SELECT "userId" FROM reported_users))
        )
        -- Another image sharing the stored file, found by the snapshot's url once the subject's own
        -- image row is gone.
        OR EXISTS (
          SELECT 1 FROM "Image" so
          WHERE so.url = coalesce((SELECT li.url FROM "Image" li WHERE li.id = s."imageId"), s.url)
            AND so.id IS DISTINCT FROM s."imageId"
            AND (so."needsReview" = 'csam' OR so."blockedFor" = 'CSAM'
              OR so."userId" IN (SELECT "userId" FROM reported_users)
              OR so.id::text IN (SELECT id FROM reported_images))
        )
    )
    SELECT coalesce(sum(label_store.exclude('image', "subjectId", 'safety')), 0)::int AS excluded FROM hit
  `;
  return excluded + (await sweepRemovedModelText());
}

// A model's judged text is its owner's, and may name a real person: once the model is deleted, the
// store keeps the judgements and drops the text ('removed'). Bounded per run; the next run continues.
async function sweepRemovedModelText() {
  const [{ removed }] = await dbWrite.$queryRaw<{ removed: number }[]>`
    WITH gone AS (
      SELECT DISTINCT s."subjectId"
      FROM label_store.subject s
      WHERE s."subjectType" = 'model_text' AND s."excludedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "Model" m
          WHERE m.id = CASE WHEN s."subjectId" ~ '^[0-9]{1,10}$' AND s."subjectId"::bigint <= 2147483647
              THEN s."subjectId"::int END
            AND m."deletedAt" IS NULL
        )
      LIMIT ${BATCH}
    )
    SELECT coalesce(sum(label_store.exclude('model_text', "subjectId", 'removed')), 0)::int AS removed
    FROM gone
  `;
  return removed;
}

const forgetOrphanKey = (key: string) => dbWrite.$executeRaw`
  DELETE FROM "AppealTrainingObjectDeletion" WHERE key = ${key}
`;

/** Keyed, so a record can be matched to a later report on its owner without storing who it is. */
const ownerHash = (key: string, userId: number) =>
  createHmac('sha256', key).update(String(userId)).digest('hex');

async function reportedOwnerHashes() {
  const key = env.APPEAL_OWNER_HASH_KEY;
  if (!key) return [];
  const owners = await dbWrite.$queryRaw<{ userId: number }[]>`
    SELECT DISTINCT "userId" FROM "CsamReport" WHERE "userId" IS NOT NULL
  `;
  return owners.map((o) => ownerHash(key, o.userId));
}

/** Deletes training objects; keys it could not delete are kept for the next sweep to retry. */
async function discardTrainingObjects(
  store: AppealTrainingStore | null | undefined,
  keys: string[]
) {
  keys = [...new Set(keys)];
  if (!keys.length) return 0;
  try {
    store ??= await appealTrainingStoreFromEnv();
    if (!store) throw new Error('training bucket not configured');
    await store.remove(keys);
    await dbWrite.$executeRaw`
      DELETE FROM "AppealTrainingObjectDeletion" WHERE key = ANY(${keys}::text[])
    `;
    return keys.length;
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: JOB_LOG_NAME,
      message: 'Could not delete training objects; queued for retry',
      details: { keys, error: (e as Error).message },
    });
    await dbWrite.$executeRaw`
      INSERT INTO "AppealTrainingObjectDeletion" (key)
      SELECT unnest(${keys}::text[])
      ON CONFLICT (key) DO NOTHING
    `;
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

/** Rows without a removal label are retried for a while; ClickHouse can lag the decision. */
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
const ORPHAN_GRACE = Prisma.raw(`make_interval(hours => 1)`);
const COPY_BATCH = 200;

const COPY_LABELS: string[] = [
  ViolationType.Bestiality,
  ViolationType.SexualViolence,
  ViolationType.MindAlteredNsfw,
  ViolationType.FecalMatter,
  ViolationType.Gore,
  ViolationType.Anorexia,
  ViolationType.BodilyFluids,
  ViolationType.Incest,
  ViolationType.Hate,
  ViolationType.Spam,
];
const RATED_COPY_LABELS: string[] = [ViolationType.RealPerson, 'poi'];

// Anything not listed, or with an unknown rating, is not copied.
const copyableRecord = (r: Prisma.Sql) => Prisma.sql`coalesce(
  ${r}."removalLabel" = ANY(${COPY_LABELS}::text[])
  OR (
    ${r}."removalLabel" = ANY(${RATED_COPY_LABELS}::text[])
    AND ${r}."removalNsfw" IN ('None', 'Soft')
    AND coalesce(${r}."aiNsfwLevel", 0) IN (0, 1, 2)
  ),
  false
)`;

const pendingCopy = (r: Prisma.Sql) =>
  Prisma.sql`${r}.decision = 'Rejected' AND ${r}."trainingCopyState" IS NULL`;

/** Holds an image against `remove-blocked-images` while its training copy is pending. `i` must name an "Image" row. */
export const appealTrainingHeld = (i: Prisma.Sql) => {
  const h = Prisma.raw('h');
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "AppealDecisionRecord" h
    WHERE h."imageId" = ${i}.id
      AND ${pendingCopy(h)}
      AND CASE
        WHEN h."removalLabel" IS NULL THEN h."decidedAt" > now() - ${UNLABELLED_HOLD}
        ELSE h."decidedAt" > now() - ${COPY_WINDOW} AND ${copyableRecord(h)}
      END
      AND NOT ${ineligibleRecord(h)}
  )`;
};

export type AppealTrainingStore = {
  /** Copies the original stored under `imageUrl` to `key` in the training bucket. */
  copy: (imageUrl: string, key: string) => Promise<void>;
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
    async copy(imageUrl, key) {
      const original = await source.send(
        new GetObjectCommand({ Bucket: sourceBucket, Key: imageUrl })
      );
      if (!original.Body) throw new Error('original has no body');
      await target.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key: key,
          Body: await original.Body.transformToByteArray(),
          ContentType: original.ContentType,
        })
      );
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
export const isAppealTrainingConfigured = () =>
  appealTrainingConfig() !== null && !!env.APPEAL_OWNER_HASH_KEY;

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

/** Runs before `remove-blocked-images` purges the originals; see `appealTrainingHeld`. */
export async function copyRejectedForTraining({
  store,
  lookup = removalLabelsFromClickhouse,
}: { store?: AppealTrainingStore | null; lookup?: RemovalLabelLookup } = {}) {
  if (store === undefined) store = await appealTrainingStoreFromEnv();
  const ownerKey = env.APPEAL_OWNER_HASH_KEY;
  if (!store || !ownerKey) {
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
    {
      appealId: number;
      imageUrl: string;
      ownerId: number | null;
      action: 'copy' | 'skip' | 'wait';
    }[]
  >`
    SELECT r."appealId", r."imageUrl", oi."userId" AS "ownerId",
      CASE
        WHEN r."decidedAt" <= now() - ${COPY_WINDOW}
          OR NOT EXISTS (SELECT 1 FROM "Image" ci WHERE ci.id = r."imageId")
          OR ${ineligibleRecord(r)}
          THEN 'skip'
        WHEN r."removalLabel" IS NULL THEN 'wait'
        WHEN ${copyableRecord(r)} THEN 'copy'
        ELSE 'skip'
      END AS action
    FROM "AppealDecisionRecord" r
    LEFT JOIN "Image" oi ON oi.id = r."imageId"
    WHERE ${pendingCopy(r)}
      AND NOT (r."removalLabel" IS NULL AND r."decidedAt" > now() - ${COPY_WINDOW})
    ORDER BY r."decidedAt"
    LIMIT ${COPY_BATCH}
  `;

  const skipIds = pending.filter((p) => p.action === 'skip').map((p) => p.appealId);
  if (skipIds.length) await setCopyState(skipIds, 'skipped');

  let copied = 0;
  let discarded = 0;
  let failed = 0;
  for (const { appealId, imageUrl, ownerId } of pending.filter((p) => p.action === 'copy')) {
    const key = `${appealId}/${imageUrl}`;
    try {
      if (ownerId === null) throw new Error('image owner unknown');
      // Queued first, so a copy that never gets attached to its record is still deleted.
      await dbWrite.$executeRaw`
        INSERT INTO "AppealTrainingObjectDeletion" (key) VALUES (${key})
        ON CONFLICT (key) DO UPDATE SET "createdAt" = now()
      `;
      await store.copy(imageUrl, key);
      // The record may have been swept or become ineligible while the copy ran.
      if (await markCopied(appealId, key, ownerHash(ownerKey, ownerId))) {
        await forgetOrphanKey(key);
        copied++;
      } else if (await isRecordedKey(key)) await forgetOrphanKey(key);
      else {
        await discardTrainingObjects(store, [key]);
        discarded++;
      }
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

  return { configured: true, labelled, copied, discarded, skipped: skipIds.length, failed };
}

function setCopyState(appealIds: number[], state: string, key: string | null = null) {
  return dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord"
    SET "trainingCopyState" = ${state}, "trainingObjectKey" = ${key}
    WHERE "appealId" = ANY(${appealIds}::int[]) AND "trainingCopyState" IS NULL
  `;
}

async function isRecordedKey(key: string) {
  const rows = await dbWrite.$queryRaw<unknown[]>`
    SELECT 1 FROM "AppealDecisionRecord" WHERE "trainingObjectKey" = ${key} LIMIT 1
  `;
  return rows.length > 0;
}

async function markCopied(appealId: number, key: string, owner: string) {
  const r = Prisma.raw('r');
  const updated = await dbWrite.$executeRaw`
    UPDATE "AppealDecisionRecord" r
    SET "trainingCopyState" = 'copied', "trainingObjectKey" = ${key}, "ownerHash" = ${owner}
    WHERE r."appealId" = ${appealId} AND r."trainingCopyState" IS NULL
      AND NOT ${ineligibleRecord(r)}
  `;
  return updated > 0;
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
  // The store first: deleting a record also excludes its image from the store, under a vaguer reason.
  const storeExcluded = await sweepLabelStore().catch((e: Error) => {
    logToAxiom({
      type: 'error',
      name: JOB_LOG_NAME,
      message: 'Label store sweep failed',
      details: { error: e.message },
    });
    return 0;
  });
  const { swept, labels, expired, objects } = await sweepExcludedRecords();
  const labelled = await fillRemovalLabels(lookup);
  const { restored, corrected } = await recordRestoredLevels();
  return { swept, labels, expired, objects, storeExcluded, labelled, restored, corrected };
}

export const appealDecisionRecordsJob = createJob('appeal-decision-records', '40 4 * * *', () =>
  runAppealDecisionRecords()
);

export const appealTrainingCopyJob = createJob('appeal-training-copy', '*/10 * * * *', () =>
  copyRejectedForTraining()
);
