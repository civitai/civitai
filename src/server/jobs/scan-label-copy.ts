import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { instrumentB2Client } from '~/server/prom/b2-put.metrics';
import { excludedImageRow } from './appeal-decision-records';
import { createJob } from './job';

/**
 * Copies the images of decided scan label items to the scan label review bucket.
 *
 * Which items may be copied is the "ScanLabelCopyEligibility" view's decision, applied to the database
 * separately. Without the view the query fails and nothing is copied or marked; an item the view
 * leaves out is never copied. The bucket key may only write: nothing here reads back, lists or
 * deletes, and the bucket expires objects itself.
 */

const JOB_LOG_NAME = 'scan-label-copy';
const BATCH = 50;
// Blocked originals are purged after about a week; an older item has nothing left to copy.
const COPY_WINDOW = Prisma.raw(`make_interval(days => 6)`);

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

type Pending = { id: number; url: string; action: 'copy' | 'skip' };

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
      SELECT i.id, img.url,
        CASE
          WHEN i."decidedAt" > now() - ${COPY_WINDOW}
            AND e."eligibleForCopy" IS TRUE
            -- NULL-safe: the exclusion is NULL, not false, for an image with no review flag.
            AND NOT COALESCE(${excludedImageRow(img)}, false)
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
  for (const { id, url } of pending.filter((p) => p.action === 'copy')) {
    const key = `${id}/${url}`;
    try {
      await store.put(url, key);
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
