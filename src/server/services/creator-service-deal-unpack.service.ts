import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
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
  ZipRejectedError,
  type OpenedZip,
  type ZipEntry,
} from '~/server/utils/service-deal-zip';
import {
  SERVICE_FINAL_SCAN_GIVE_UP_MS,
  SERVICE_PREVIEW_MAX_NSFW_LEVEL,
  SERVICE_SCAN_COPY_SWEEP_MS,
  SERVICE_UNPACK_STALE_MS,
  SERVICE_ZIP_IMAGE_EXTENSIONS,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
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

/** The level a Final's image may carry. Today every service is SFW-only. */
const MAX_LEVEL = Prisma.sql`${SERVICE_PREVIEW_MAX_NSFW_LEVEL}::int`;

type ClaimedFinal = {
  id: number;
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
    RETURNING f."id", f."s3Key", f."fileName", f."size", d."sellerId"`;
}

const release = (fileId: number) =>
  dbWrite.$executeRaw`UPDATE "ServiceDealFile" SET "processingAt" = NULL WHERE "id" = ${fileId}::int`;

/**
 * A Final that cannot be accepted as it is. The reason is what the seller reads; the file fails its
 * scan, which blocks delivery and sends an already delivered deal to the moderators.
 */
async function refuseFinal(fileId: number, reason: string) {
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "failReason" = ${reason}::text, "unpackedAt" = now(), "processingAt" = NULL
    WHERE "id" = ${fileId}::int`;
  await recordFinalScanResult({ fileId, verdict: 'Failed' });
}

const markUnpacked = (fileId: number) =>
  dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" SET "unpackedAt" = now(), "processingAt" = NULL
    WHERE "id" = ${fileId}::int`;

type EntryRow = {
  id: number;
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
    SELECT "id", "imageId", "scanKey", "scanStatus"::text AS "scanStatus" FROM "ServiceDealFileEntry"
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
    // The file was deleted while this ran: nothing points at the copy any more.
    const { deleteImageById } = await import('~/server/services/image.service');
    await deleteImageById({ id: imageId, updatePost: false }).catch(() => null);
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
        INSERT INTO "ServiceDealFileEntry" ("fileId", "entryIndex", "path", "size")
        VALUES (${file.id}::int, ${entry.index}::int, ${entry.path}::text, ${entry.size}::int)
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

/** A Final that is itself an image has a single entry: the file. */
async function unpackImage(file: ClaimedFinal) {
  if (file.size > SERVICE_ZIP_MAX_IMAGE_BYTES)
    throw new ZipRejectedError('That image is too large to deliver.');
  await dbWrite.$executeRaw`
    INSERT INTO "ServiceDealFileEntry" ("fileId", "entryIndex", "path", "size")
    VALUES (${file.id}::int, 0, ${file.fileName}::text, ${file.size}::int)
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
    }
    await markUnpacked(file.id);
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
    await release(file.id);
    return 0;
  }
}

/**
 * Step 2: the scan's verdict on each image. Clean and within the rating passes it; a block, any
 * flag that sends an image to review, or a rating above the limit fails it. A scan that could not
 * run, or that never settles, fails it without calling its content bad.
 */
export async function settleEntryScans() {
  const waiting = Prisma.sql`e."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"`;
  const passed = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Passed'::"ServiceDealFileScanStatus", "nsfwLevel" = i."nsfwLevel"
    FROM "Image" i
    WHERE i."id" = e."imageId" AND ${waiting}
      AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"
      AND i."needsReview" IS NULL AND NOT i."poi" AND NOT i."minor"
      AND i."nsfwLevel" BETWEEN 1 AND ${MAX_LEVEL}`;
  const rejected = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Failed'::"ServiceDealFileScanStatus", "nsfwLevel" = i."nsfwLevel",
      "failReason" = 'An image in this file was rejected when it was checked.'
    FROM "Image" i
    WHERE i."id" = e."imageId" AND ${waiting}
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

/**
 * Step 3: a Final's verdict from its parts. One failed image, or a failed malware scan, fails it.
 * It passes only when it is unpacked, every image passed and the malware scan passed; until a
 * malware scanner is wired that last condition never holds, so no Final passes on its images alone.
 */
export async function settleFinals() {
  const failing = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT f."id" FROM "ServiceDealFile" f
    WHERE f."kind" = 'Final'::"ServiceDealFileKind"
      AND f."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND (f."malwareScanStatus" = 'Failed'::"ServiceDealFileScanStatus"
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
      AND f."malwareScanStatus" = 'Passed'::"ServiceDealFileScanStatus"
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
 * Step 4: a copy has done its job once its image passed, or once the file it belongs to has been
 * settled some other way (another image failed, the malware scan did) and the copy has had time to
 * finish scanning. The copy of a REJECTED image is kept: its Image row is what the moderation
 * tooling reads, and deleting it would take the evidence with it. A delete that fails stays
 * pointed at and is retried.
 */
export async function deleteEntryScanCopies({ limit = 50 } = {}) {
  const rows = await dbWrite.$queryRaw<{ id: number; imageId: number }[]>`
    SELECT e."id", e."imageId" FROM "ServiceDealFileEntry" e
    JOIN "ServiceDealFile" f ON f."id" = e."fileId"
    WHERE e."imageId" IS NOT NULL
      AND (e."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
        OR (e."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
          AND f."scanStatus" <> 'Pending'::"ServiceDealFileScanStatus"
          AND e."createdAt" < now() - (${SERVICE_SCAN_COPY_SWEEP_MS}::int * interval '1 millisecond')))
    ORDER BY e."id" LIMIT ${limit}::int`;
  if (!rows.length) return 0;
  const { deleteImageById } = await import('~/server/services/image.service');
  let deleted = 0;
  for (const row of rows) {
    try {
      await deleteImageById({ id: row.imageId, updatePost: false });
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
