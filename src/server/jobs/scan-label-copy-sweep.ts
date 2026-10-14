import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { excludedObject } from './scan-label-copy';
import { createJob } from './job';

const JOB_LOG_NAME = 'scan-label-copy-sweep';
const BATCH = 200;

export type WithdrawReason = 'excluded' | 'ineligible' | 'gone';

export type ScanLabelSweepStore = {
  /** Removes every version of exactly `key`; an absent key is already removed. */
  remove: (key: string) => Promise<void>;
};

/**
 * 🔴 B2 turns a DeleteObject without a VersionId into a hide marker, which is a write the delete key
 * is refused. Every version is listed and deleted by id instead, and the listing is by prefix, so
 * only exact key matches are deleted.
 */
export function createScanLabelSweepStore({
  client,
  bucket,
}: {
  client: Pick<S3Client, 'send'>;
  bucket: string;
}): ScanLabelSweepStore {
  return {
    async remove(key) {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      do {
        const page = await client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: key,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          })
        );
        const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter(
          (v) => v.Key === key && v.VersionId
        );
        for (const v of versions)
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: v.VersionId })
          );
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker);
    },
  };
}

function sweepConfig() {
  const bucket = env.SCAN_LABEL_P3_B2_BUCKET;
  const endpoint = env.SCAN_LABEL_P3_B2_ENDPOINT;
  const region = env.SCAN_LABEL_P3_B2_REGION;
  const accessKeyId = env.SCAN_LABEL_P3_B2_DELETE_ACCESS_KEY;
  const secretAccessKey = env.SCAN_LABEL_P3_B2_DELETE_SECRET_KEY;
  if (!bucket || !endpoint || !region || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, region, accessKeyId, secretAccessKey };
}

export function scanLabelSweepStoreFromEnv(): ScanLabelSweepStore | null {
  const config = sweepConfig();
  if (!config) return null;
  return createScanLabelSweepStore({
    client: new S3Client({
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
    }),
    bucket: config.bucket,
  });
}

type Due = { key: string; itemId: number; reason: WithdrawReason };

async function dueForWithdrawal(): Promise<{ due: Due[]; eligibilityRead: boolean }> {
  const img = Prisma.raw('img');
  const due = await dbWrite.$queryRaw<Due[]>`
    SELECT o.key, o."itemId",
      CASE WHEN i.id IS NULL OR img.id IS NULL THEN 'gone' ELSE 'excluded' END AS reason
    FROM "ScanLabelCopyObject" o
    LEFT JOIN "ScanLabelItem" i ON i.id = o."itemId"
    LEFT JOIN "Image" img ON img.id = o."imageId"
    WHERE o."withdrawnAt" IS NULL
      AND (i.id IS NULL OR img.id IS NULL OR ${excludedObject(img)})
    LIMIT ${BATCH}
  `;
  // A separate query: without the view, the checks above must still run.
  try {
    const seen = new Set(due.map((d) => d.key));
    const ineligible = await dbWrite.$queryRaw<Due[]>`
      SELECT o.key, o."itemId", 'ineligible' AS reason
      FROM "ScanLabelCopyObject" o
      JOIN "ScanLabelItem" i ON i.id = o."itemId"
      LEFT JOIN "ScanLabelCopyEligibility" e ON e."itemId" = i.id
      WHERE o."withdrawnAt" IS NULL AND e."eligibleForCopy" IS NOT TRUE
      LIMIT ${BATCH}
    `;
    for (const d of ineligible) if (!seen.has(d.key)) due.push(d);
    return { due, eligibilityRead: true };
  } catch (e) {
    logToAxiom({
      type: 'warning',
      name: JOB_LOG_NAME,
      message: 'Could not read copy eligibility; withdrawing excluded and gone copies only',
      details: { error: (e as Error).message },
    });
    return { due, eligibilityRead: false };
  }
}

/** Withdraws copies whose item or image no longer qualifies. Idempotent: a withdrawn copy is final. */
export async function sweepScanLabelCopies({ store }: { store?: ScanLabelSweepStore | null } = {}) {
  if (store === undefined) store = scanLabelSweepStoreFromEnv();
  if (!store) {
    logToAxiom({
      type: 'warning',
      name: JOB_LOG_NAME,
      message: 'Scan label delete key not configured; nothing withdrawn',
    });
    return { configured: false };
  }

  const { due, eligibilityRead } = await dueForWithdrawal();
  let withdrawn = 0;
  let failed = 0;
  for (const { key, itemId, reason } of due) {
    try {
      await store.remove(key);
      await dbWrite.$executeRaw`
        UPDATE "ScanLabelCopyObject"
        SET "withdrawnAt" = now(), "withdrawReason" = ${reason}, "withdrawError" = NULL
        WHERE key = ${key}
      `;
      await dbWrite.$executeRaw`
        UPDATE "ScanLabelItem" SET "copyState" = 'withdrawn', "copyKey" = NULL
        WHERE id = ${itemId} AND "copyKey" = ${key}
      `;
      withdrawn++;
    } catch (e) {
      failed++;
      const message = (e as Error).message;
      await dbWrite.$executeRaw`
        UPDATE "ScanLabelCopyObject" SET "withdrawError" = ${message.slice(
          0,
          500
        )} WHERE key = ${key}
      `;
      logToAxiom({
        type: 'error',
        name: JOB_LOG_NAME,
        message: 'Scan label copy withdrawal failed',
        details: { key, error: message },
      });
    }
  }
  return { configured: true, eligibilityRead, withdrawn, failed };
}

export const scanLabelCopySweepJob = createJob('scan-label-copy-sweep', '7,22,37,52 * * * *', () =>
  sweepScanLabelCopies()
);
