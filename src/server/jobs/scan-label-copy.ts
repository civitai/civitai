import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { instrumentB2Client } from '~/server/prom/b2-put.metrics';
import { excludedImageRow } from './appeal-decision-records';
import { createJob } from './job';

// Eligibility is decided by the "ScanLabelCopyEligibility" view, applied to the database separately.
// The write key is put-only and the bucket expires objects itself; withdrawals are
// `scan-label-copy-sweep`'s, with a key of their own.

const JOB_LOG_NAME = 'scan-label-copy';
const BATCH = 50;
// Must stay under the blocked-original purge age, or the copy reads originals that are gone.
const COPY_WINDOW = Prisma.raw(`make_interval(days => 6)`);

/**
 * An image the copy must not hold: excluded on its own row, or sharing its stored object with an image
 * that is. NULL-safe: the exclusion is NULL, not false, for an image with no review flag.
 */
export const excludedObject = (img: Prisma.Sql) => Prisma.sql`(
  COALESCE(${excludedImageRow(img)}, false)
  OR EXISTS (
    SELECT 1 FROM "Image" so
    WHERE so.url = ${img}.url AND COALESCE(${excludedImageRow(Prisma.raw('so'))}, false)
  )
)`;

export type ScanLabelCopyStore = { put: (imageUrl: string, key: string) => Promise<void> };

export function createScanLabelCopyStore({
  source,
  sourceBucket,
  target,
  targetBucket,
}: {
  source: S3Client;
  sourceBucket: string;
  target: S3Client;
  targetBucket: string;
}): ScanLabelCopyStore {
  return {
    async put(imageUrl, key) {
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
  };
}

function scanLabelCopyConfig() {
  const bucket = env.SCAN_LABEL_P3_B2_BUCKET;
  const endpoint = env.SCAN_LABEL_P3_B2_ENDPOINT;
  const region = env.SCAN_LABEL_P3_B2_REGION;
  const accessKeyId = env.SCAN_LABEL_P3_B2_ACCESS_KEY;
  const secretAccessKey = env.SCAN_LABEL_P3_B2_SECRET_KEY;
  if (!bucket || !endpoint || !region || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, region, accessKeyId, secretAccessKey };
}

export async function scanLabelCopyStoreFromEnv(): Promise<ScanLabelCopyStore | null> {
  const config = scanLabelCopyConfig();
  if (!config) return null;
  // Imported here: s3-utils reads upload env at load, which this module's importers need not have.
  const { getImageUploadBackend } = await import('~/utils/s3-utils');
  const { s3, bucket: sourceBucket } = await getImageUploadBackend();
  return createScanLabelCopyStore({
    source: s3,
    sourceBucket,
    target: instrumentB2Client(
      new S3Client({
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: true,
      })
    ),
    targetBucket: config.bucket,
  });
}

type Pending = { id: number; imageId: number; url: string; action: 'copy' | 'skip' };

export async function copyScanLabelImages({ store }: { store?: ScanLabelCopyStore | null } = {}) {
  if (store === undefined) store = await scanLabelCopyStoreFromEnv();
  if (!store) {
    logToAxiom({
      type: 'warning',
      name: JOB_LOG_NAME,
      message: 'Scan label bucket not configured; nothing copied',
    });
    return { configured: false };
  }

  const img = Prisma.raw('img');
  let pending: Pending[];
  try {
    pending = await dbWrite.$queryRaw<Pending[]>`
      SELECT i.id, i."imageId", img.url,
        CASE
          WHEN i."decidedAt" > now() - ${COPY_WINDOW}
            AND e."eligibleForCopy" IS TRUE
            AND NOT ${excludedObject(img)}
            THEN 'copy'
          ELSE 'skip'
        END AS action
      FROM "ScanLabelItem" i
      JOIN "Image" img ON img.id = i."imageId"
      LEFT JOIN "ScanLabelCopyEligibility" e ON e."itemId" = i.id
      WHERE i.status = 'decided' AND (i."copyState" IS NULL OR i."copyState" = 'failed')
      ORDER BY i."copyState" IS NOT NULL, i."decidedAt"
      LIMIT ${BATCH}
    `;
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: JOB_LOG_NAME,
      message: 'Could not read copy eligibility; nothing copied',
      details: { error: (e as Error).message },
    });
    return { configured: true, eligibility: false };
  }

  const skipIds = pending.filter((p) => p.action === 'skip').map((p) => p.id);
  if (skipIds.length)
    await dbWrite.$executeRaw`
      UPDATE "ScanLabelItem" SET "copyState" = 'skipped', "copyError" = NULL
      WHERE id IN (${Prisma.join(skipIds)})
    `;

  let copied = 0;
  let failed = 0;
  for (const { id, imageId, url } of pending.filter((p) => p.action === 'copy')) {
    const key = `${id}/${url}`;
    try {
      // Ledgered before the upload, so a copy whose bookkeeping never lands can still be withdrawn,
      // and re-armed after it: a sweep may have marked this key withdrawn while it was absent.
      await dbWrite.$executeRaw`
        INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES (${key}, ${id}, ${imageId})
        ON CONFLICT ("key") DO NOTHING
      `;
      await store.put(url, key);
      await dbWrite.$executeRaw`
        UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = NULL, "withdrawReason" = NULL, "removedAt" = NULL
        WHERE key = ${key}
      `;
      await dbWrite.$executeRaw`
        UPDATE "ScanLabelItem"
        SET "copyState" = 'copied', "copyKey" = ${key}, "copiedAt" = now(), "copyError" = NULL
        WHERE id = ${id}
      `;
      copied++;
    } catch (e) {
      failed++;
      const message = (e as Error).message;
      await dbWrite.$executeRaw`
        UPDATE "ScanLabelItem" SET "copyState" = 'failed', "copyError" = ${message.slice(0, 500)}
        WHERE id = ${id}
      `;
      logToAxiom({
        type: 'error',
        name: JOB_LOG_NAME,
        message: 'Scan label copy failed',
        details: { itemId: id, error: message },
      });
    }
  }
  return { configured: true, eligibility: true, copied, skipped: skipIds.length, failed };
}

export const scanLabelCopyJob = createJob('scan-label-copy', '*/15 * * * *', () =>
  copyScanLabelImages()
);
