import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  getFinalScanReading,
  isFinalsMalwareScanOn,
  submitFinalScan,
  type FinalScanTarget,
} from '~/server/services/creator-service-deal-file-scan';
import {
  createScanImage,
  fileExtension,
  readObject,
  recordFinalScanResult,
} from '~/server/services/creator-service-deal-file.service';
import { buildEntryScanCopy, PreviewRejectedError } from '~/server/utils/service-deal-preview';
import {
  openZip,
  readEntry,
  s3ZipSource,
  sniffEntry,
  ZipRejectedError,
  type OpenedZip,
  type ZipEntry,
} from '~/server/utils/service-deal-zip';
import {
  SERVICE_FINAL_SCAN_GIVE_UP_MS,
  SERVICE_FINAL_SCAN_MAX_ATTEMPTS,
  SERVICE_FINAL_SCAN_RETRY_MS,
  SERVICE_FINAL_SCAN_STALE_MS,
  SERVICE_UNPACK_RETRY_MS,
  SERVICE_UNPACK_STALE_MS,
  SERVICE_ZIP_IMAGE_EXTENSIONS,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
  SERVICE_ZIP_MODEL_EXTENSIONS,
} from '~/shared/constants/creator-services.constants';
import { getBucket, getS3Client, uploadImageBufferToStore } from '~/utils/s3-utils';

/**
 * Unpacks the Finals of a deal and sends every image in them through the normal image scan.
 *
 * A zip is read by the jobs pool, one at a time, as a stream: never in a request, never to disk,
 * never holding more than one entry. Each image gets a hidden, downscaled, unmarked copy in the
 * image store, scanned like any upload. A passed copy is deleted; a rejected one is kept for the
 * moderators. Results are stored per image (`ServiceDealFileEntry`) and aggregated: a Final passes
 * only when every image passed AND its malware scan passed (`recordFinalScanResult` enforces both),
 * and any image that fails fails the whole Final.
 *
 * Steps are claimed per file and idempotent, so a pod that rolls mid-way leaves the file where the
 * next run picks it up, with no second ingest of an image already submitted.
 */

const logUnpack = (message: string, fields: Record<string, unknown>, type = 'info') =>
  logToAxiom({ name: 'creator-service-unpack', type, message, ...fields }).catch(() => null);

/** The highest rating an image in a Final may carry: the deal's own. */
const MAX_LEVEL = Prisma.sql`d."maxNsfwLevel"`;

type ClaimedFinal = {
  id: number;
  dealId: number;
  s3Key: string;
  fileName: string;
  size: number;
  sellerId: number;
};

const isImageName = (name: string) =>
  (SERVICE_ZIP_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(name));

/** Takes the one Final that no run holds and that has not been unpacked, oldest first. */
function claimFinal() {
  return dbWrite.$queryRaw<ClaimedFinal[]>`
    UPDATE "ServiceDealFile" f SET "processingAt" = now()
    FROM "ServiceDeal" d
    WHERE d."id" = f."dealId" AND f."id" IN (
      SELECT p."id" FROM "ServiceDealFile" p
      WHERE p."kind" = 'Final'::"ServiceDealFileKind"
        AND p."status" = 'Ready'::"ServiceDealFileStatus"
        AND p."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
        AND p."unpackedAt" IS NULL
        AND (p."processingAt" IS NULL
          OR p."processingAt" < now() - (${SERVICE_UNPACK_STALE_MS}::int * interval '1 millisecond'))
      ORDER BY p."id" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING f."id", f."dealId", f."s3Key", f."fileName", f."size", d."sellerId"`;
}

/** Keeps the file out of the next runs for a while, so one file that keeps failing cannot hold up the rest. */
export const retryLater = (fileId: number) =>
  dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "processingAt" = now() - ((${
      SERVICE_UNPACK_STALE_MS - SERVICE_UNPACK_RETRY_MS
    }::int) * interval '1 millisecond')
    WHERE "id" = ${fileId}::int`;

const release = (fileId: number) =>
  dbWrite.$executeRaw`UPDATE "ServiceDealFile" SET "processingAt" = NULL WHERE "id" = ${fileId}::int`;

/**
 * A Final that cannot be accepted as it is. The reason is what the seller reads; the file fails its
 * scan, which blocks delivery and sends an already delivered deal to the moderators.
 */
export async function refuseFinal(fileId: number, reason: string) {
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "failReason" = ${reason}::text, "unpackedAt" = now(), "processingAt" = NULL
    WHERE "id" = ${fileId}::int`;
  await recordFinalScanResult({ fileId, verdict: 'Failed' });
}

/** `repacked`: there is nothing to rebuild (not a zip), so the file is ready for its scan as it is. */
const markUnpacked = (fileId: number, repacked: boolean) =>
  dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "unpackedAt" = now(), "processingAt" = NULL,
      "repackedAt" = CASE WHEN ${repacked} THEN now() ELSE NULL END
    WHERE "id" = ${fileId}::int`;

/**
 * Hands a file to the malware scan once it is ready, naming the object a buyer would download. With
 * the scan off it records the step as skipped instead (see `isFinalsMalwareScanOn`).
 */
export async function handOffToScan(fileId: number) {
  if (!(await isFinalsMalwareScanOn())) {
    await dbWrite.$executeRaw`
      UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus"
      WHERE "id" = ${fileId}::int AND "malwareScanStatus" = 'Pending'::"ServiceDealFileScanStatus"`;
    return;
  }
  const [target] = await dbWrite.$queryRaw<FinalScanTarget[]>`
    SELECT "id", "dealId", "mimeType",
      COALESCE("deliveryKey", "s3Key") AS "s3Key", COALESCE("deliverySize", "size") AS "size"
    FROM "ServiceDealFile" WHERE "id" = ${fileId}::int`;
  if (target) await submitFinalScan(target);
}

type EntryRow = {
  id: number;
  dealId: number;
  path: string;
  size: number;
  imageId: number | null;
  scanKey: string | null;
  scanStatus: string;
};

/**
 * Submits one image's hidden copy to the scan. The copy's key is recorded BEFORE its Image row
 * exists, so a crash between the two leaves a key the retry reuses rather than a second object.
 */
async function submitEntryImage(
  fileId: number,
  entryIndex: number,
  original: Buffer,
  sellerId: number
) {
  const [row] = await dbWrite.$queryRaw<EntryRow[]>`
    SELECT "id", "dealId", "path", "size", "imageId", "scanKey", "scanStatus"::text AS "scanStatus"
    FROM "ServiceDealFileEntry"
    WHERE "fileId" = ${fileId}::int AND "entryIndex" = ${entryIndex}::int`;
  // An image already submitted, or already judged and its copy deleted, is never ingested again.
  if (!row || row.imageId || row.scanStatus !== 'Pending') return;

  let imageId: number | undefined;
  if (row.scanKey) {
    // A crash left the object, and maybe the Image row: find it so it is never ingested twice.
    const [existing] = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "Image" WHERE "url" = ${row.scanKey}::text LIMIT 1`;
    imageId = existing?.id;
  }
  if (!imageId) {
    const copy = await buildEntryScanCopy(original);
    let scanKey = row.scanKey;
    if (!scanKey) {
      ({ key: scanKey } = await uploadImageBufferToStore(copy.data, {
        contentType: copy.mimeType,
      }));
      await dbWrite.$executeRaw`
        UPDATE "ServiceDealFileEntry" SET "scanKey" = ${scanKey}::text WHERE "id" = ${row.id}::int`;
    }
    imageId = (await createScanImage(scanKey, copy, sellerId)).id;
  }
  const attached = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" SET "imageId" = ${imageId}::int WHERE "id" = ${row.id}::int`;
  if (attached === 0) {
    // The file was deleted while this ran. The copy's scan has not finished, so it is kept, with a
    // row of its own that no file owns, like any other copy left when its file is deleted.
    await dbWrite.$executeRaw`
      INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size", "imageId", "scanKey")
      VALUES (NULL, ${row.dealId}::int, ${entryIndex}::int, ${row.path}::text, ${row.size}::int,
        ${imageId}::int, (SELECT "url" FROM "Image" WHERE "id" = ${imageId}::int))`;
  }
}

const failEntry = (fileId: number, entryIndex: number, reason: string) =>
  dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry"
    SET "scanStatus" = 'Failed'::"ServiceDealFileScanStatus", "failReason" = ${reason}::text
    WHERE "fileId" = ${fileId}::int AND "entryIndex" = ${entryIndex}::int`;

/** Pass 1: every entry is inflated and judged; nothing is kept. Returns the images found. */
async function validateZip({ zipfile, entries }: OpenedZip, shouldStop: () => boolean) {
  const budget = { used: 0 };
  const images: ZipEntry[] = [];
  for (const entry of entries) {
    if (shouldStop()) return null;
    const read = await readEntry(zipfile, entry, budget, () => false);
    if (read.kind === 'image') images.push(entry);
  }
  return images;
}

async function unpackZip(file: ClaimedFinal, shouldStop: () => boolean) {
  const source = s3ZipSource(getS3Client(), await getBucket(), file.s3Key, file.size);
  const opened = await openZip(source);
  try {
    const images = await validateZip(opened, shouldStop);
    if (!images) return false;

    // The rows exist before any image is submitted, so the file cannot pass with one unjudged.
    for (const entry of images)
      await dbWrite.$executeRaw`
        INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size")
        VALUES (${file.id}::int, ${file.dealId}::int, ${entry.index}::int, ${entry.path}::text,
          ${entry.size}::int)
        ON CONFLICT ("fileId", "entryIndex") DO NOTHING`;

    // Pass 2: one image in memory at a time. Each is read again, so a crash resumes at the next.
    const budget = { used: 0 };
    for (const entry of images) {
      if (shouldStop()) return false;
      const read = await readEntry(opened.zipfile, entry, budget, (kind) => kind === 'image');
      try {
        await submitEntryImage(file.id, entry.index, read.data!, file.sellerId);
      } catch (error) {
        if (!(error instanceof PreviewRejectedError)) throw error;
        await failEntry(file.id, entry.index, 'An image in this file could not be read.');
        throw new ZipRejectedError('An image in the archive could not be read.');
      }
    }
    return true;
  } finally {
    opened.zipfile.close();
  }
}

const isModelName = (name: string) =>
  (SERVICE_ZIP_MODEL_EXTENSIONS as readonly string[]).includes(fileExtension(name));

/**
 * A Final that is not an archive, an image or a model file is judged by its first bytes, not its
 * name: an image or a video called notes.txt is still one. Returns whether it is an image.
 */
async function isImageByContent(file: ClaimedFinal) {
  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: await getBucket(), Key: file.s3Key, Range: 'bytes=0-15' })
  );
  if (!response.Body) throw new Error('Empty object body');
  const kind = sniffEntry(Buffer.from(await response.Body.transformToByteArray()));
  if (kind === 'video') throw new ZipRejectedError('Video cannot be delivered yet.');
  if (kind === 'archive')
    throw new ZipRejectedError('Archives must be delivered as a .zip, not renamed.');
  if (kind === 'unscannable')
    throw new ZipRejectedError(
      'This image format cannot be delivered. Use PNG, JPEG, WebP or GIF.'
    );
  return kind === 'image';
}

/** A Final that is itself an image has a single entry: the file. */
async function unpackImage(file: ClaimedFinal) {
  if (file.size > SERVICE_ZIP_MAX_IMAGE_BYTES)
    throw new ZipRejectedError('That image is too large to deliver.');
  await dbWrite.$executeRaw`
    INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size")
    VALUES (${file.id}::int, ${file.dealId}::int, 0, ${file.fileName}::text, ${file.size}::int)
    ON CONFLICT ("fileId", "entryIndex") DO NOTHING`;
  const original = await readObject(await getBucket(), file.s3Key);
  try {
    await submitEntryImage(file.id, 0, original, file.sellerId);
  } catch (error) {
    if (!(error instanceof PreviewRejectedError)) throw error;
    await failEntry(file.id, 0, 'This image could not be read.');
    throw new ZipRejectedError('This image could not be read.');
  }
}

/**
 * Step 1: unpack one Final that has not been. A problem with the file itself fails it with a
 * reason the seller can read; anything else (a dropped connection) leaves it to be retried.
 * Returns the number of files finished.
 */
export async function unpackFinals({
  shouldStop = () => false,
}: { shouldStop?: () => boolean } = {}) {
  const [file] = await claimFinal();
  if (!file) return 0;
  const began = Date.now();
  try {
    const extension = fileExtension(file.fileName);
    if (extension === 'zip') {
      if (!(await unpackZip(file, shouldStop))) {
        await release(file.id);
        return 0;
      }
    } else if (isImageName(file.fileName)) {
      await unpackImage(file);
    } else if (!isModelName(file.fileName) && (await isImageByContent(file))) {
      await unpackImage(file);
    }
    await markUnpacked(file.id, extension !== 'zip');
    // A hand-off that fails is logged; `settleMalwareScans` submits it again.
    if (extension !== 'zip')
      await handOffToScan(file.id).catch((error) =>
        logUnpack(
          'scan hand-off failed',
          { fileId: file.id, error: (error as Error)?.message },
          'error'
        )
      );
    logUnpack('final unpacked', { fileId: file.id, ms: Date.now() - began });
    return 1;
  } catch (error) {
    if (error instanceof ZipRejectedError) {
      await refuseFinal(file.id, error.message);
      logUnpack('final refused', { fileId: file.id, ms: Date.now() - began });
      return 1;
    }
    logUnpack(
      'unpack failed; it will be retried',
      { fileId: file.id, error: (error as Error)?.message },
      'error'
    );
    await retryLater(file.id);
    return 0;
  }
}

/**
 * Step 2: the scan's verdict on each image. A scan that could not run, or that never settles,
 * fails it without calling its content bad.
 */
export async function settleEntryScans() {
  const waiting = Prisma.sql`e."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"`;
  const passed = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Passed'::"ServiceDealFileScanStatus", "nsfwLevel" = i."nsfwLevel"
    FROM "Image" i, "ServiceDeal" d
    WHERE i."id" = e."imageId" AND d."id" = e."dealId" AND ${waiting}
      AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"
      AND i."needsReview" IS NULL AND NOT i."poi" AND NOT i."minor"
      AND i."nsfwLevel" BETWEEN 1 AND ${MAX_LEVEL}`;
  const rejected = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Failed'::"ServiceDealFileScanStatus", "nsfwLevel" = i."nsfwLevel",
      "failReason" = 'An image in this file was rejected when it was checked.'
    FROM "Image" i, "ServiceDeal" d
    WHERE i."id" = e."imageId" AND d."id" = e."dealId" AND ${waiting}
      AND (i."ingestion" = 'Blocked'::"ImageIngestionStatus"
        OR (i."ingestion" = 'Scanned'::"ImageIngestionStatus"
          AND (i."needsReview" IS NOT NULL OR i."poi" OR i."minor"
            OR i."nsfwLevel" NOT BETWEEN 1 AND ${MAX_LEVEL})))`;
  const unchecked = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Failed'::"ServiceDealFileScanStatus",
      "failReason" = 'An image in this file could not be checked.'
    FROM "Image" i
    WHERE i."id" = e."imageId" AND ${waiting}
      AND i."ingestion" = 'NotFound'::"ImageIngestionStatus"`;
  const timedOut = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Failed'::"ServiceDealFileScanStatus",
      "failReason" = 'An image in this file could not be checked.'
    WHERE ${waiting}
      AND e."createdAt" < now() - (${SERVICE_FINAL_SCAN_GIVE_UP_MS}::int * interval '1 millisecond')`;
  return { passed, rejected, unchecked, timedOut };
}

const WAITING_FOR_MALWARE_SCAN = Prisma.sql`
  "kind" = 'Final'::"ServiceDealFileKind"
  AND "scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
  AND "malwareScanStatus" = 'Pending'::"ServiceDealFileScanStatus"`;

/**
 * Step 3: the malware scan of each Final ready for it (see the scan module). Polls the workflows
 * waiting for a verdict and records it; a scan that could not reach one, or has had none for too
 * long, is dropped and submitted again. A Final that is not waiting on a workflow is submitted,
 * which also takes up a hand-off that was lost. While the scan is on, a Final that has used its
 * attempts, or has waited past the give-up window, fails its malware scan, so a round never hangs
 * and nothing unscanned reaches the buyer. Returns counts.
 */
export async function settleMalwareScans({
  shouldStop = () => false,
  submitLimit = 1,
}: { shouldStop?: () => boolean; submitLimit?: number } = {}) {
  const counts = {
    scansPassed: 0,
    scansFailed: 0,
    scansRetried: 0,
    scansSubmitted: 0,
    scansGivenUp: 0,
  };

  const waiting = await dbWrite.$queryRaw<{ id: number; workflowId: string; stale: boolean }[]>`
    SELECT "id", "malwareScanWorkflowId" AS "workflowId",
      "malwareScanSubmittedAt" < now() - (${SERVICE_FINAL_SCAN_STALE_MS}::int * interval '1 millisecond') AS "stale"
    FROM "ServiceDealFile"
    WHERE ${WAITING_FOR_MALWARE_SCAN} AND "malwareScanWorkflowId" IS NOT NULL
    ORDER BY "id" LIMIT 50`;
  for (const { id, workflowId, stale } of waiting) {
    if (shouldStop()) return counts;
    const reading = await getFinalScanReading(workflowId).catch((error) => {
      logUnpack(
        'malware scan read failed',
        { fileId: id, workflowId, error: (error as Error)?.message },
        'error'
      );
      return null;
    });
    const sameWorkflow = Prisma.sql`"id" = ${id}::int AND "malwareScanWorkflowId" = ${workflowId}::text
      AND "malwareScanStatus" = 'Pending'::"ServiceDealFileScanStatus"`;
    if (reading === 'Passed' || reading === 'Failed') {
      const recorded = await dbWrite.$executeRaw`
        UPDATE "ServiceDealFile" SET "malwareScanStatus" = ${reading}::"ServiceDealFileScanStatus"
        WHERE ${sameWorkflow}`;
      if (recorded) counts[reading === 'Passed' ? 'scansPassed' : 'scansFailed']++;
      if (recorded && reading === 'Failed')
        logUnpack('malware scan failed', { fileId: id, workflowId });
    } else if (reading === 'Retry' || stale) {
      counts.scansRetried += await dbWrite.$executeRaw`
        UPDATE "ServiceDealFile" SET "malwareScanWorkflowId" = NULL WHERE ${sameWorkflow}`;
      logUnpack('malware scan will be submitted again', { fileId: id, workflowId, reading });
    }
  }

  if (!(await isFinalsMalwareScanOn())) {
    // Hands each Final waiting with no workflow back, which records its scan as skipped.
    const orphans = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "ServiceDealFile"
      WHERE ${WAITING_FOR_MALWARE_SCAN} AND "malwareScanWorkflowId" IS NULL AND "repackedAt" IS NOT NULL
      ORDER BY "id" LIMIT 50`;
    for (const { id } of orphans) await handOffToScan(id);
    return counts;
  }

  const givenUp = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "ServiceDealFile"
    SET "malwareScanStatus" = 'Failed'::"ServiceDealFileScanStatus",
      "failReason" = COALESCE("failReason", 'This file could not be checked. Upload it again.')
    WHERE ${WAITING_FOR_MALWARE_SCAN} AND "repackedAt" IS NOT NULL
      AND (("malwareScanAttempts" >= ${SERVICE_FINAL_SCAN_MAX_ATTEMPTS}::int
          AND "malwareScanWorkflowId" IS NULL)
        OR COALESCE("malwareScanStartedAt", "repackedAt")
          < now() - (${SERVICE_FINAL_SCAN_GIVE_UP_MS}::int * interval '1 millisecond'))
    RETURNING "id"`;
  counts.scansGivenUp = givenUp.length;
  if (givenUp.length) logUnpack('malware scans given up', { fileIds: givenUp.map(({ id }) => id) });

  const due = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "ServiceDealFile"
    WHERE ${WAITING_FOR_MALWARE_SCAN} AND "repackedAt" IS NOT NULL AND "failReason" IS NULL
      AND "malwareScanWorkflowId" IS NULL
      AND ("malwareScanSubmittedAt" IS NULL
        OR "malwareScanSubmittedAt" < now() - (${SERVICE_FINAL_SCAN_RETRY_MS}::int * interval '1 millisecond'))
    ORDER BY "id" LIMIT ${submitLimit}::int`;
  for (const { id } of due) {
    if (shouldStop()) return counts;
    try {
      await handOffToScan(id);
      counts.scansSubmitted++;
    } catch (error) {
      logUnpack(
        'malware scan submit failed; it will be retried',
        { fileId: id, error: (error as Error)?.message },
        'error'
      );
    }
  }
  return counts;
}

/**
 * Step 4: a Final's verdict from its parts. One failed image, or a failed malware scan, fails it.
 * It passes only when it is unpacked and every image and the malware scan passed; while the scan is
 * off, a skipped one counts. Once it is on, a Final still waiting whose scan was skipped goes back
 * to waiting for it, on a fresh give-up clock, and `settleMalwareScans` submits it. One already
 * Passed on a skipped scan stays Passed.
 */
export async function settleFinals() {
  const malwareScanOn = await isFinalsMalwareScanOn();
  if (malwareScanOn) {
    const skipped = await dbWrite.$queryRaw<{ id: number }[]>`
      UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Pending'::"ServiceDealFileScanStatus",
        "malwareScanWorkflowId" = NULL, "malwareScanSubmittedAt" = NULL, "malwareScanAttempts" = 0,
        "malwareScanStartedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "ServiceDealFile"
        WHERE "kind" = 'Final'::"ServiceDealFileKind"
          AND "scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
          AND "malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus"
        ORDER BY "id" LIMIT 50)
      RETURNING "id"`;
    if (skipped.length) logUnpack('skipped malware scans queued', { count: skipped.length });
  }

  const failing = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT f."id" FROM "ServiceDealFile" f
    WHERE f."kind" = 'Final'::"ServiceDealFileKind"
      AND f."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND (f."failReason" IS NOT NULL
        OR (f."unpackedAt" < now() - (${SERVICE_FINAL_SCAN_GIVE_UP_MS}::int * interval '1 millisecond')
          AND f."repackedAt" IS NULL)
        OR f."malwareScanStatus" = 'Failed'::"ServiceDealFileScanStatus"
        OR EXISTS (SELECT 1 FROM "ServiceDealFileEntry" e
          WHERE e."fileId" = f."id" AND e."scanStatus" = 'Failed'::"ServiceDealFileScanStatus"))
    ORDER BY f."id" LIMIT 50`;
  let failed = 0;
  for (const { id } of failing) {
    await dbWrite.$executeRaw`
      UPDATE "ServiceDealFile"
      SET "failReason" = COALESCE("failReason", 'A file in this delivery was rejected when it was checked.')
      WHERE "id" = ${id}::int`;
    const result = await recordFinalScanResult({ fileId: id, verdict: 'Failed' });
    if (result.recorded) failed++;
  }

  const clear = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT f."id" FROM "ServiceDealFile" f
    WHERE f."kind" = 'Final'::"ServiceDealFileKind"
      AND f."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND f."unpackedAt" IS NOT NULL
      AND f."repackedAt" IS NOT NULL
      AND (f."malwareScanStatus" = 'Passed'::"ServiceDealFileScanStatus"
        OR (f."malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus" AND NOT ${malwareScanOn}))
      AND NOT EXISTS (SELECT 1 FROM "ServiceDealFileEntry" e
        WHERE e."fileId" = f."id" AND e."scanStatus" <> 'Passed'::"ServiceDealFileScanStatus")
    ORDER BY f."id" LIMIT 50`;
  let passed = 0;
  for (const { id } of clear) {
    const result = await recordFinalScanResult({ fileId: id, verdict: 'Passed' });
    if (result.recorded) passed++;
  }
  return { finalsFailed: failed, finalsPassed: passed };
}

/**
 * Step 5: the copy of an image that passed has done its job. The copy of an image whose scan has not
 * finished, or that was rejected, is KEPT, even after its file was deleted: its Image row is what
 * the moderation tooling reads, and deleting it would take the evidence with it. A copy whose file
 * is gone is judged like any other (see `settleEntryScans`) and its row goes with it once it
 * passes. A delete that fails stays pointed at and is retried.
 */
export async function deleteEntryScanCopies({ limit = 50 } = {}) {
  const rows = await dbWrite.$queryRaw<{ id: number; imageId: number; fileId: number | null }[]>`
    SELECT e."id", e."imageId", e."fileId" FROM "ServiceDealFileEntry" e
    WHERE e."imageId" IS NOT NULL AND e."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
    ORDER BY e."id" LIMIT ${limit}::int`;
  if (!rows.length) return 0;
  const { deleteImageById } = await import('~/server/services/image.service');
  let deleted = 0;
  for (const row of rows) {
    try {
      await deleteImageById({ id: row.imageId, updatePost: false });
      if (row.fileId === null)
        await dbWrite.$executeRaw`DELETE FROM "ServiceDealFileEntry" WHERE "id" = ${row.id}::int`;
      else
        await dbWrite.$executeRaw`
          UPDATE "ServiceDealFileEntry" SET "imageId" = NULL, "scanKey" = NULL WHERE "id" = ${row.id}::int`;
      deleted++;
    } catch (error) {
      logUnpack(
        'scan copy delete failed; it will be retried',
        { entryId: row.id, imageId: row.imageId, error: (error as Error)?.message },
        'error'
      );
    }
  }
  return deleted;
}
