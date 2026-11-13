import { Prisma } from '@prisma/client';
import { CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { getEdgeUrl } from '~/client-utils/edge-url';
import type {
  ServiceDealAccessKind,
  ServiceDealAccessRole,
  Tracker,
} from '~/server/clickhouse/tracker';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { holdServiceDealForReview } from '~/server/services/creator-service-escrow.service';
import { transitionDeal } from '~/server/services/creator-service-deal.service';
import {
  dealReadyToDeliver,
  liveFile,
  SCANNED_FILE_KINDS,
} from '~/server/services/creator-service-deal-file-sql';
import { isFinalsMalwareScanOn } from '~/server/services/creator-service-deal-file-scan';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
  throwServiceUnavailableError,
} from '~/server/utils/errorHandling';
import {
  buildScanCopy,
  buildWatermarkedPreview,
  PreviewRejectedError,
} from '~/server/utils/service-deal-preview';
import {
  SERVICE_ATTACHMENT_MAX_FILES,
  SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS,
  SERVICE_FINAL_EXTENSIONS,
  SERVICE_FINAL_MAX_BYTES,
  SERVICE_FINAL_MAX_FILES,
  SERVICE_PREVIEW_ANIMATED_MAX_BYTES,
  SERVICE_PREVIEW_GIVE_UP_MS,
  SERVICE_PREVIEW_MAX_BYTES,
  SERVICE_PREVIEW_MAX_FILES,
  SERVICE_PREVIEW_MAX_NSFW_LEVEL,
  SERVICE_PREVIEW_MIME_TYPES,
  SERVICE_DEAL_HOLD_REASONS,
  SERVICE_PREVIEW_PROCESSING_STALE_MS,
  SERVICE_ZIP_IMAGE_EXTENSIONS,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
} from '~/shared/constants/creator-services.constants';
import type {
  ServiceDealFileKind,
  ServiceDealFileScanStatus,
  ServiceDealFileStatus,
  ServicePreviewKind,
} from '~/shared/utils/prisma/enums';
import {
  deleteObject,
  getBucket,
  getGetUrlByKey,
  getPutUrl,
  getS3Client,
  headObject,
  uploadImageBufferToStore,
} from '~/utils/s3-utils';

/**
 * Delivery files for a Creator Services deal.
 *
 * Who may do what is decided in SQL on the deal row, never from an id in the input: uploads need
 * the deal's seller and a deal still being worked (Accepted or InRevision). A file belongs to the
 * deal's CURRENT round (`revisionsUsed`), the same round the escrow's gates read.
 *
 * An Attachment is the buyer's: uploaded from the request until the seller delivers, scanned by the
 * Final pipeline, and kept from the seller until it passes. Nothing that gates delivery or payout
 * counts it.
 */

/** Statuses a seller may upload in. */
const WORKING = Prisma.sql`'Accepted'::"ServiceDealStatus", 'InRevision'::"ServiceDealStatus"`;
/** Statuses a buyer may attach in: from the request until the seller delivers. */
const ATTACHABLE = Prisma.sql`'Requested'::"ServiceDealStatus", 'Accepted'::"ServiceDealStatus",
  'InRevision'::"ServiceDealStatus"`;
// Compared as text, so seller paths do not depend on the enum value existing: the client deploys
// before the migration that adds it.
const NOT_ATTACHMENT = Prisma.sql`f."kind"::text <> 'Attachment'`;
const LIVE_F = liveFile(Prisma.sql`f`);
/** A deal that ended without the work: the seller loses the buyer's attachments. */
const CLOSED_TO_SELLER = new Set(['Declined', 'Expired', 'Cancelled']);

const UPLOAD_KEY_ROOT = 'service-deals';
const HELD_COPY_ATTEMPTS = 3;

/** What a seller types is shown back; strip paths and control characters, and bound it. */
export function cleanFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'file').slice(0, 120);
}

/** The extension of a file name, lower-cased; a name with none has none. */
export const fileExtension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Refuses a Final we cannot inspect: an unknown type, or an archive other than a plain .zip. */
export function assertFinalFileType(fileName: string) {
  const extension = fileExtension(cleanFileName(fileName));
  if (!(SERVICE_FINAL_EXTENSIONS as readonly string[]).includes(extension))
    throw throwBadRequestError(
      'This file type cannot be delivered. Use a .zip, a model file, or an image, audio or text file.'
    );
}

/** The type and size limits a Final has, which an Attachment shares. */
function assertScannableFile(fileName: string, size: number) {
  assertFinalFileType(fileName);
  if (size > SERVICE_FINAL_MAX_BYTES) throw throwBadRequestError('That file is too large.');
  // An image is scanned whole, so it has its own, lower, cap.
  if (
    (SERVICE_ZIP_IMAGE_EXTENSIONS as readonly string[]).includes(
      fileExtension(cleanFileName(fileName))
    ) &&
    size > SERVICE_ZIP_MAX_IMAGE_BYTES
  )
    throw throwBadRequestError(
      `An image cannot be more than ${Math.floor(SERVICE_ZIP_MAX_IMAGE_BYTES / (1024 * 1024))} MB.`
    );
}

const isPreviewMime = (mime: string) =>
  (SERVICE_PREVIEW_MIME_TYPES as readonly string[]).includes(mime);

/** GIF and WebP may be animated, so they get the animated allowance until the bytes say otherwise. */
const previewByteCap = (mime: string) =>
  mime === 'image/gif' || mime === 'image/webp'
    ? SERVICE_PREVIEW_ANIMATED_MAX_BYTES
    : SERVICE_PREVIEW_MAX_BYTES;

type UploadDealRow = {
  id: number;
  round: number;
  previewKind: ServicePreviewKind;
  files: number;
};

export async function requestServiceDealUpload({
  dealId,
  userId,
  kind,
  fileName,
  mimeType,
  size,
}: {
  dealId: number;
  userId: number;
  kind: Exclude<ServiceDealFileKind, 'Attachment'>;
  fileName: string;
  mimeType: string;
  size: number;
}) {
  // The input schema says the same; a caller that skips it must not create a buyer's Attachment.
  if (kind !== 'Preview' && kind !== 'Final') throw throwBadRequestError('Unknown file kind.');
  // The buyer sees the file name. Scanned as it will be stored.
  await throwOnBlockedUserContent(cleanFileName(fileName), { surface: 'service-deal-file' });

  if (kind === 'Preview') {
    if (!isPreviewMime(mimeType))
      throw throwBadRequestError('Previews must be JPEG, PNG, WebP or GIF images.');
    if (size > previewByteCap(mimeType))
      throw throwBadRequestError(
        `Preview is too large (max ${Math.floor(previewByteCap(mimeType) / (1024 * 1024))} MB).`
      );
  } else {
    assertScannableFile(fileName, size);
  }

  const created = await dbWrite.$transaction(async (tx) => {
    // Lock the deal row so two uploads cannot both pass the count below.
    const [deal] = await tx.$queryRaw<UploadDealRow[]>`
      SELECT d."id", d."revisionsUsed" AS "round", d."previewKind",
        (SELECT count(*)::int FROM "ServiceDealFile" f
          WHERE f."dealId" = d."id" AND f."round" = d."revisionsUsed"
            AND f."kind" = ${kind}::"ServiceDealFileKind" AND ${LIVE_F}) AS "files"
      FROM "ServiceDeal" d
      WHERE d."id" = ${dealId}::int AND d."sellerId" = ${userId}::int
        AND d."status" IN (${WORKING})
      FOR UPDATE`;
    // 404 for a deal that is not theirs, and the same for one that has moved on.
    if (!deal) throw throwNotFoundError('Deal not found');

    if (kind === 'Preview') {
      const max = SERVICE_PREVIEW_MAX_FILES[deal.previewKind];
      if (max === 0) throw throwBadRequestError('This service does not take a preview.');
      if (deal.files >= max)
        throw throwConflictError(`This delivery already has ${max === 1 ? 'a' : max} preview.`);
    } else if (deal.files >= SERVICE_FINAL_MAX_FILES) {
      throw throwConflictError(`A delivery can have at most ${SERVICE_FINAL_MAX_FILES} files.`);
    }

    // The key is minted here from the ids alone, never from the file name.
    const s3Key = `${UPLOAD_KEY_ROOT}/uploads/${dealId}/${
      deal.round
    }/${kind.toLowerCase()}/${randomUUID()}`;
    const [row] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceDealFile" ("dealId", "round", "kind", "s3Key", "fileName", "mimeType", "size")
      VALUES (${dealId}::int, ${deal.round}::int, ${kind}::"ServiceDealFileKind", ${s3Key}::text,
        ${cleanFileName(fileName)}::text, ${mimeType}::text, ${size}::int)
      RETURNING "id"`;
    return { id: row.id, s3Key };
  });

  const { url } = await getPutUrl(created.s3Key);
  return { fileId: created.id, uploadUrl: url };
}

/**
 * The buyer attaches a file to their deal. The attestations are required by the input schema; the
 * time they were given is stored on the row.
 */
export async function requestServiceDealAttachment({
  dealId,
  userId,
  fileName,
  mimeType,
  size,
  rightsAttested,
  likenessAttested,
}: {
  dealId: number;
  userId: number;
  fileName: string;
  mimeType: string;
  size: number;
  rightsAttested: boolean;
  likenessAttested: boolean;
}) {
  // `attestedAt` records both; the input schema requires them too.
  if (rightsAttested !== true || likenessAttested !== true)
    throw throwBadRequestError('Confirm both statements to attach files.');
  // An Attachment passes only on a malware scan that ran (see `recordFinalScanResult`).
  if (!(await isFinalsMalwareScanOn()))
    throw throwBadRequestError('Attaching files is not available right now.');
  // The seller sees the file name once the file passes. Scanned as it will be stored.
  await throwOnBlockedUserContent(cleanFileName(fileName), { surface: 'service-deal-file' });
  assertScannableFile(fileName, size);

  const created = await dbWrite.$transaction(async (tx) => {
    const [deal] = await tx.$queryRaw<{ id: number; round: number; files: number }[]>`
      SELECT d."id", d."revisionsUsed" AS "round",
        (SELECT count(*)::int FROM "ServiceDealFile" f
          WHERE f."dealId" = d."id" AND f."kind"::text = 'Attachment' AND ${LIVE_F}) AS "files"
      FROM "ServiceDeal" d
      WHERE d."id" = ${dealId}::int AND d."buyerId" = ${userId}::int
        AND d."status" IN (${ATTACHABLE})
      FOR UPDATE`;
    if (!deal) throw throwNotFoundError('Deal not found');
    if (deal.files >= SERVICE_ATTACHMENT_MAX_FILES)
      throw throwConflictError(
        `A request can have at most ${SERVICE_ATTACHMENT_MAX_FILES} attached files.`
      );

    const s3Key = `${UPLOAD_KEY_ROOT}/uploads/${dealId}/${deal.round}/attachment/${randomUUID()}`;
    const [row] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceDealFile"
        ("dealId", "round", "kind", "s3Key", "fileName", "mimeType", "size", "attestedAt")
      VALUES (${dealId}::int, ${
      deal.round
    }::int, 'Attachment'::"ServiceDealFileKind", ${s3Key}::text,
        ${cleanFileName(fileName)}::text, ${mimeType}::text, ${size}::int, now())
      RETURNING "id"`;
    return { id: row.id, s3Key };
  });

  const { url } = await getPutUrl(created.s3Key);
  return { fileId: created.id, uploadUrl: url };
}

type OwnedFileRow = {
  id: number;
  dealId: number;
  round: number;
  kind: ServiceDealFileKind;
  s3Key: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: ServiceDealFileStatus;
  imageId: number | null;
};

/** Which of a deal's files a user may change: `scope` is a condition on `f` and `d`. */
async function findOwnFile(fileId: number, scope: Prisma.Sql) {
  const [file] = await dbWrite.$queryRaw<OwnedFileRow[]>`
    SELECT f."id", f."dealId", f."round", f."kind", f."s3Key", f."fileName", f."mimeType", f."size",
      f."status", f."imageId"
    FROM "ServiceDealFile" f JOIN "ServiceDeal" d ON d."id" = f."dealId"
    WHERE f."id" = ${fileId}::int AND ${scope}`;
  return file ?? null;
}

/** The seller's own delivery file, in the current round of a deal still being worked. */
const sellerScope = (userId: number) => Prisma.sql`d."sellerId" = ${userId}::int
  AND d."status" IN (${WORKING}) AND f."round" = d."revisionsUsed" AND ${NOT_ATTACHMENT}
  AND ${LIVE_F}`;

/** The buyer's own attachment, in a deal the seller has not delivered yet. */
const buyerAttachmentScope = (userId: number) => Prisma.sql`d."buyerId" = ${userId}::int
  AND d."status" IN (${ATTACHABLE}) AND f."kind"::text = 'Attachment' AND ${LIVE_F}`;

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * The first bytes of a zip: it must be one, and its first entry must not be encrypted. A cheap
 * check from a ranged read; the whole directory is read when the archive is unpacked.
 */
export function zipHeaderRefusal(head: Buffer) {
  if (head.length < 8 || !head.subarray(0, 4).equals(ZIP_LOCAL_HEADER))
    return 'This is not a valid .zip file.';
  // General-purpose flag, bit 0: the entry is encrypted.
  if (head.readUInt16LE(6) & 1) return 'Password-protected archives cannot be delivered.';
  return null;
}

async function zipRefusal(bucket: string, key: string) {
  try {
    const response = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-63' })
    );
    if (!response.Body) return 'This is not a valid .zip file.';
    return zipHeaderRefusal(Buffer.from(await response.Body.transformToByteArray()));
  } catch {
    // Not a verdict on the file: the bucket could not be read. Nothing is deleted.
    throw throwConflictError('The upload could not be checked yet. Try again in a moment.');
  }
}

/**
 * Fails a file. `onlyFrom` limits it to a file still in that status: a call that lost a race must
 * not undo another call that already moved the file on (an upload completed twice at once).
 */
const failFile = (fileId: number, reason: string, onlyFrom: ServiceDealFileStatus | null = null) =>
  dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "status" = 'Failed'::"ServiceDealFileStatus", "failReason" = ${reason}::text
    WHERE "id" = ${fileId}::int
      AND (${onlyFrom}::text IS NULL OR "status"::text = ${onlyFrom}::text)`;

export const completeServiceDealUpload = ({ fileId, userId }: { fileId: number; userId: number }) =>
  completeUpload(fileId, sellerScope(userId));

export const completeServiceDealAttachment = ({
  fileId,
  userId,
}: {
  fileId: number;
  userId: number;
}) => completeUpload(fileId, buyerAttachmentScope(userId));

/**
 * The uploader says the bytes are in the bucket. They hold a long-lived upload URL for the key
 * they were given, so nothing they could still write to is trusted: the object is COPIED to a key
 * only the server ever has, and every check here, and every later read, is of that copy. A size
 * that is not the declared one fails the file and removes both objects.
 */
async function completeUpload(fileId: number, scope: Prisma.Sql) {
  const file = await findOwnFile(fileId, scope);
  if (!file) throw throwNotFoundError('File not found');
  if (file.status !== 'Uploading') return { id: file.id, status: file.status };

  const bucket = await getBucket();
  const uploaded = await headObject(bucket, file.s3Key);
  if (uploaded.status === 'unknown') throw couldNotCheck();
  if (uploaded.status === 'absent')
    throw throwBadRequestError('The file has not finished uploading.');

  const heldKey = `${UPLOAD_KEY_ROOT}/files/${file.dealId}/${
    file.round
  }/${file.kind.toLowerCase()}/${randomUUID()}`;
  try {
    await getS3Client().send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: heldKey,
        CopySource: encodeURI(`${bucket}/${file.s3Key}`),
      })
    );
  } catch {
    // Not a verdict on the file: the bucket could not be read. Nothing is deleted.
    throw couldNotCheck();
  }

  // The copy is what gets measured. The uploader can no longer change it.
  const held = await headObject(bucket, heldKey);
  if (held.status === 'unknown') throw couldNotCheck();
  if (held.status === 'absent' || held.size !== file.size) {
    const reason = 'The uploaded file did not match its declared size.';
    if ((await failFile(file.id, reason, 'Uploading')) === 0) return currentState(file.id);
    await discardFailedUpload(bucket, file, heldKey);
    throw throwBadRequestError(reason);
  }

  if (file.kind !== 'Preview' && fileExtension(file.fileName) === 'zip') {
    const refusal = await zipRefusal(bucket, heldKey);
    if (refusal) {
      if ((await failFile(file.id, refusal, 'Uploading')) === 0) return currentState(file.id);
      await discardFailedUpload(bucket, file, heldKey);
      throw throwBadRequestError(refusal);
    }
  }

  // A preview is processed by the job; a final or attachment is ready now and is unpacked by the job.
  const next: ServiceDealFileStatus = file.kind === 'Preview' ? 'Processing' : 'Ready';
  // Under the deal lock and the same scope as the lookup: the deal may have moved on (a delivery
  // closes the attach window) while the copy above was being made.
  const moved = await dbWrite.$transaction(async (tx) => {
    const [deal] = await tx.$queryRaw<{ id: number }[]>`
      SELECT d."id" FROM "ServiceDeal" d JOIN "ServiceDealFile" f ON f."dealId" = d."id"
      WHERE f."id" = ${file.id}::int AND ${scope}
      FOR UPDATE OF d`;
    if (!deal) return null;
    return tx.$executeRaw`
      UPDATE "ServiceDealFile"
      SET "status" = ${next}::"ServiceDealFileStatus", "uploadedAt" = now(), "s3Key" = ${heldKey}::text
      WHERE "id" = ${file.id}::int AND "status" = 'Uploading'::"ServiceDealFileStatus"`;
  });
  // The uploader's key is dead either way. A repeat call that lost the race removes its own copy.
  await deleteObject(bucket, moved === 1 ? file.s3Key : heldKey).catch(() => null);
  if (moved === null) throw throwConflictError('This deal no longer takes this file.');
  return { id: file.id, status: next };
}

/**
 * A refused upload: the uploader's key goes, and the server's copy goes too unless the file must be
 * kept (`mustKeep`), in which case the row points at it. The file stays Failed either way, so it
 * looks the same to its uploader and nothing but the moderator tools serves it.
 */
async function discardFailedUpload(bucket: string, file: OwnedFileRow, heldKey: string) {
  await deleteObject(bucket, file.s3Key).catch(() => null);
  const kept = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" f SET "s3Key" = ${heldKey}::text
    WHERE f."id" = ${file.id}::int AND ${mustKeep(Prisma.sql`f`)}`;
  if (!kept) await deleteObject(bucket, heldKey).catch(() => null);
}

/** A key the uploader was given and can still write to, not a copy the server made. */
const isUploaderKey = (key: string) => key.startsWith(`${UPLOAD_KEY_ROOT}/uploads/`);

/**
 * Where a file stands now. A completion that lost a race to another call returns this instead of
 * failing the file or deleting anything: the other call's result is the one that stands, and its
 * objects are not ours to remove.
 */
async function currentState(fileId: number) {
  const [row] = await dbWrite.$queryRaw<{ status: ServiceDealFileStatus }[]>`
    SELECT "status" FROM "ServiceDealFile" WHERE "id" = ${fileId}::int`;
  if (!row) throw throwNotFoundError('File not found');
  return { id: fileId, status: row.status };
}

const couldNotCheck = () =>
  throwConflictError('The upload could not be checked yet. Try again in a moment.');

/**
 * Removes a file from a delivery that has not been sent yet. The deal row is locked first, as
 * delivering locks it, so a delete cannot slip between "the round is ready" and "it is delivered".
 */
export const deleteServiceDealFile = ({ fileId, userId }: { fileId: number; userId: number }) =>
  deleteFile(fileId, sellerScope(userId));

/** The buyer removes an attachment, until the seller delivers. */
export const deleteServiceDealAttachment = ({
  fileId,
  userId,
}: {
  fileId: number;
  userId: number;
}) => deleteFile(fileId, buyerAttachmentScope(userId));

async function deleteFile(fileId: number, scope: Prisma.Sql) {
  const removed = await dbWrite.$transaction(async (tx) => {
    const [deal] = await tx.$queryRaw<{ id: number }[]>`
      SELECT d."id" FROM "ServiceDeal" d JOIN "ServiceDealFile" f ON f."dealId" = d."id"
      WHERE f."id" = ${fileId}::int AND ${scope}
      FOR UPDATE OF d`;
    if (!deal) throw throwNotFoundError('File not found');
    // Re-read under the lock: the state above is the one that is true now. Every entry is locked,
    // so an unpack still attaching copies waits for this to finish.
    await tx.$queryRaw`
      SELECT 1 FROM "ServiceDealFileEntry" e WHERE e."fileId" = ${fileId}::int FOR UPDATE OF e`;
    // An image that passed has no more use for its copy.
    const copies = await tx.$queryRaw<{ imageId: number }[]>`
      SELECT e."imageId" FROM "ServiceDealFileEntry" e
      WHERE e."fileId" = ${fileId}::int AND e."imageId" IS NOT NULL
        AND e."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"`;
    // A file that must be kept stays, with its entries and objects, out of the parties' sight.
    const [kept] = await tx.$queryRaw<{ id: number; s3Key: string }[]>`
      UPDATE "ServiceDealFile" f SET "removedAt" = now()
      WHERE f."id" = ${fileId}::int AND ${mustKeep(Prisma.sql`f`)}
      RETURNING f."id", f."s3Key"`;
    if (kept) {
      await tx.$executeRaw`
        UPDATE "ServiceDealFileEntry" SET "imageId" = NULL, "scanKey" = NULL
        WHERE "fileId" = ${fileId}::int AND "scanStatus" = 'Passed'::"ServiceDealFileScanStatus"`;
      return { kept, copies };
    }
    await tx.$executeRaw`DELETE FROM "ServiceDealFileEntry" e WHERE e."fileId" = ${fileId}::int`;
    const [file] = await tx.$queryRaw<FileObjects[]>`
      DELETE FROM "ServiceDealFile" f USING "ServiceDeal" d
      WHERE f."id" = ${fileId}::int AND d."id" = f."dealId" AND ${scope}
      RETURNING f."id", f."s3Key", f."deliveryKey", f."imageId"`;
    if (!file) throw throwNotFoundError('File not found');
    return { file, copies };
  });

  await deleteImages(removed.copies.map(({ imageId }) => imageId));
  if (removed.kept) {
    // An upload never completed still sits at the uploader's key, which they can write to: the
    // server keeps its own copy instead.
    if (isUploaderKey(removed.kept.s3Key))
      await keepServerCopy(await getBucket(), removed.kept.id, removed.kept.s3Key);
    return { id: removed.kept.id };
  }
  await deleteFileObjects(removed.file);
  return { id: removed.file.id };
}

type FileObjects = {
  id: number;
  s3Key: string;
  deliveryKey: string | null;
  imageId: number | null;
};

async function deleteImages(imageIds: number[]) {
  if (!imageIds.length) return;
  const { deleteImageById } = await import('~/server/services/image.service');
  for (const id of imageIds) await deleteImageById({ id, updatePost: false }).catch(() => null);
}

/** The row is the source of truth; an object left behind is unreachable and harmless. */
async function deleteFileObjects(file: FileObjects) {
  const bucket = await getBucket();
  await deleteObject(bucket, file.s3Key).catch(() => null);
  if (file.deliveryKey) await deleteObject(bucket, file.deliveryKey).catch(() => null);
  // A preview deleted mid-scan: its hidden copy goes with it.
  if (file.imageId) await deleteImages([file.imageId]);
}

/**
 * Whether a file must be kept when it is removed, judged from the row each time: its uploader is
 * named on a report, or a scan of it has not passed (an image in it, its own scan copy, or a
 * processing step still running). `f` names the file row.
 */
const mustKeep = (f: Prisma.Sql) => Prisma.sql`(${uploaderReported(f)} OR ${scanOpen(f)})`;

const uploaderReported = (f: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "CsamReport" r JOIN "ServiceDeal" rd ON rd."id" = ${f}."dealId"
  WHERE r."userId" = CASE WHEN ${f}."kind"::text = 'Attachment' THEN rd."buyerId" ELSE rd."sellerId" END
)`;

const scanOpen = (f: Prisma.Sql) => Prisma.sql`(
  EXISTS (SELECT 1 FROM "ServiceDealFileEntry" e
    WHERE e."fileId" = ${f}."id" AND e."scanStatus" <> 'Passed'::"ServiceDealFileScanStatus")
  OR (${f}."imageId" IS NOT NULL AND ${f}."scanStatus" <> 'Passed'::"ServiceDealFileScanStatus")
  OR (${f}."processingAt" IS NOT NULL AND ${f}."scanStatus" = 'Pending'::"ServiceDealFileScanStatus")
)`;

/**
 * A removed file whose scans finished clean, with an uploader not on a report, has nothing left to
 * keep: it goes as a delete would have, once its scan copies are gone. A removed file that failed stays for the moderators.
 */
export async function purgeRemovedFiles({ limit = 50 } = {}) {
  const purged = await dbWrite.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<FileObjects[]>`
      SELECT f."id", f."s3Key", f."deliveryKey", f."imageId" FROM "ServiceDealFile" f
      WHERE f."removedAt" IS NOT NULL
        AND f."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
        AND NOT ${mustKeep(Prisma.sql`f`)}
        -- Scan copies of its images go first (deleteEntryScanCopies).
        AND NOT EXISTS (SELECT 1 FROM "ServiceDealFileEntry" e
          WHERE e."fileId" = f."id" AND e."imageId" IS NOT NULL)
      ORDER BY f."id" LIMIT ${limit}::int
      FOR UPDATE OF f SKIP LOCKED`;
    if (!rows.length) return rows;
    const ids = rows.map(({ id }) => id);
    await tx.$executeRaw`DELETE FROM "ServiceDealFileEntry" WHERE "fileId" = ANY(${ids}::int[])`;
    await tx.$executeRaw`DELETE FROM "ServiceDealFile" WHERE "id" = ANY(${ids}::int[])`;
    return rows;
  });
  for (const file of purged) await deleteFileObjects(file);
  return purged.length;
}

/**
 * A kept upload that never completed: copies what is at the uploader's key to a key only the server
 * has, points the row at it, and only then deletes the uploader's key. A copy that still fails after
 * retries leaves the row and the object at the uploader's key, and is logged: a removed row on a
 * `service-deals/uploads/` key is one with no server copy.
 */
async function keepServerCopy(bucket: string, fileId: number, uploaderKey: string) {
  const serverKey = `${UPLOAD_KEY_ROOT}/held/${fileId}/${randomUUID()}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < HELD_COPY_ATTEMPTS; attempt++) {
    try {
      await getS3Client().send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: serverKey,
          CopySource: encodeURI(`${bucket}/${uploaderKey}`),
        })
      );
      await dbWrite.$executeRaw`
        UPDATE "ServiceDealFile" SET "s3Key" = ${serverKey}::text
        WHERE "id" = ${fileId}::int AND "s3Key" = ${uploaderKey}::text`;
      await deleteObject(bucket, uploaderKey).catch(() => null);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  logToAxiom({
    type: 'error',
    name: 'service-deal-file-held',
    message: 'no server copy of a kept upload',
    details: { fileId, error: (lastError as Error)?.message },
  }).catch(() => null);
}

/**
 * Records a verdict on a Final or Attachment. Only a Pending file takes one, so a repeat or late
 * result cannot overturn an earlier one. Passed also needs the file unpacked and ready, never
 * refused, its malware scan passed (or skipped while the scan is off) and every image passed. A
 * Failed Final sends a delivered deal to the moderators; one not yet delivered cannot be delivered
 * while it stands (see `dealReadyToDeliver`). A Failed Attachment holds nothing: the seller is not
 * answerable for the buyer's file, which simply never reaches them. A removed file holds nothing
 * either; a Failed one is logged and kept.
 */
export async function recordFinalScanResult({
  fileId,
  verdict,
}: {
  fileId: number;
  verdict: 'Passed' | 'Failed';
}) {
  // A skipped malware scan stands in for a passed one only for a Final and only while the scan is
  // off, so turning it on stops passing the Finals it skipped until they are scanned (see
  // `settleFinals`). An Attachment always needs a scan that ran.
  const malwareScanOn = verdict === 'Passed' ? await isFinalsMalwareScanOn() : true;
  const [file] = await dbWrite.$queryRaw<
    {
      dealId: number;
      kind: ServiceDealFileKind;
      removedAt: Date | null;
      failReason: string | null;
    }[]
  >`
    UPDATE "ServiceDealFile" SET "scanStatus" = ${verdict}::"ServiceDealFileScanStatus"
    WHERE "id" = ${fileId}::int AND "kind"::text IN (${SCANNED_FILE_KINDS})
      AND "scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND (${verdict}::text = 'Failed' OR (
        "unpackedAt" IS NOT NULL
        AND "repackedAt" IS NOT NULL
        AND "failReason" IS NULL
        AND ("malwareScanStatus" = 'Passed'::"ServiceDealFileScanStatus"
          OR ("malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus" AND NOT ${malwareScanOn}
            AND "kind"::text <> 'Attachment'))
        AND NOT EXISTS (
          SELECT 1 FROM "ServiceDealFileEntry" e
          WHERE e."fileId" = "ServiceDealFile"."id"
            AND e."scanStatus" <> 'Passed'::"ServiceDealFileScanStatus")))
    RETURNING "dealId", "kind", "removedAt", "failReason"`;
  if (!file) return { recorded: false, held: false };
  if (file.removedAt) {
    // The buyer never had this file and the round no longer counts it, so its verdict says
    // something about the uploader, not the deal.
    if (verdict === 'Failed')
      logToAxiom({
        type: 'error',
        name: 'service-deal-file-removed-failed',
        message: 'a removed deal file failed its scan',
        details: { fileId, dealId: file.dealId, kind: file.kind, failReason: file.failReason },
      }).catch(() => null);
    return { recorded: true, held: false };
  }
  const held =
    verdict === 'Failed' && file.kind === 'Final'
      ? await holdServiceDealForReview(file.dealId, SERVICE_DEAL_HOLD_REASONS.finalScanFailed)
      : false;
  return { recorded: true, held };
}

/**
 * Marks the round delivered once its files are in place. The readiness test is part of the status
 * change itself, in one statement under the deal's row lock, so a concurrent upload or delete
 * cannot make the round un-ready between the test and the write.
 */
export async function deliverServiceDeal({ dealId, userId }: { dealId: number; userId: number }) {
  const moved = await transitionDeal({
    dealId,
    from: ['Accepted', 'InRevision'],
    to: 'Delivered',
    actorId: userId,
    event: 'Delivered',
    lock: true,
    where: Prisma.sql`"sellerId" = ${userId}::int AND ${dealReadyToDeliver()}`,
    set: Prisma.sql`, "deliveredAt" = now()`,
  });
  if (moved) return { id: dealId };

  const [own] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "ServiceDeal" WHERE "id" = ${dealId}::int AND "sellerId" = ${userId}::int`;
  if (!own) throw throwNotFoundError('Deal not found');
  throw throwConflictError(
    'Upload a finished preview and at least one file, wait for them to finish processing, and try again.'
  );
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

type DealForFiles = {
  id: number;
  buyerId: number;
  sellerId: number;
  status: string;
  revisionsUsed: number;
  completedAt: Date | null;
  /** The seller has delivered the round now being worked (a Delivered event for it exists). */
  currentRoundDelivered: boolean;
};

type ListedFile = {
  id: number;
  round: number;
  kind: ServiceDealFileKind;
  fileName: string | null;
  mimeType: string | null;
  size: number;
  status: ServiceDealFileStatus;
  failReason: string | null;
  scanStatus: ServiceDealFileScanStatus | null;
  previewUrl: string | null;
  canDownload: boolean;
  /** Moderators only: when the uploader removed a file that was kept. */
  removedAt?: Date;
};

type FileRow = {
  id: number;
  round: number;
  kind: ServiceDealFileKind;
  fileName: string;
  mimeType: string;
  size: number;
  deliverySize: number | null;
  status: ServiceDealFileStatus;
  failReason: string | null;
  scanStatus: ServiceDealFileScanStatus;
  malwareScanStatus: ServiceDealFileScanStatus;
  watermarkedKey: string | null;
  removedAt: Date | null;
};

/**
 * A Final's own scan verdicts let the buyer have it. Checked at the gate as well as by
 * `recordFinalScanResult`, so a Final whose malware scan failed or never finished stays locked
 * whatever its aggregate says. A scan skipped while the scan was off counts, as it did then.
 */
const finalScansClear = (row: {
  scanStatus: ServiceDealFileScanStatus;
  malwareScanStatus: ServiceDealFileScanStatus;
}) =>
  row.scanStatus === 'Passed' &&
  (row.malwareScanStatus === 'Passed' || row.malwareScanStatus === 'NotScanned');

/** An attachment reaches the seller only on a malware scan that ran: a skipped one never counts. */
const attachmentScansClear = (row: {
  scanStatus: ServiceDealFileScanStatus;
  malwareScanStatus: ServiceDealFileScanStatus;
}) => row.scanStatus === 'Passed' && row.malwareScanStatus === 'Passed';

/** The buyer's claim on a deal's final files: it is paid for, and not since reversed. */
export const buyerOwnsFinals = (deal: Pick<DealForFiles, 'status' | 'completedAt'>) =>
  deal.status === 'Completed' || (deal.status === 'Disputed' && deal.completedAt !== null);

/**
 * Only a round the seller delivered is shown to the buyer: every earlier round (a revision was
 * asked for, so it was delivered), and the current one once a Delivered event exists for it. A
 * round still being worked stays hidden whatever state the deal is in, a cancellation included.
 */
const buyerSeesRound = (deal: DealForFiles, round: number) =>
  round < deal.revisionsUsed || (round === deal.revisionsUsed && deal.currentRoundDelivered);

export async function listServiceDealFiles({
  dealId,
  userId,
  isModerator,
  canReviewCsam = false,
}: {
  dealId: number;
  userId: number;
  isModerator: boolean;
  /** See `resolveServiceDealFileDownload`. */
  canReviewCsam?: boolean;
}) {
  const [deal] = await dbWrite.$queryRaw<DealForFiles[]>`
    SELECT d."id", d."buyerId", d."sellerId", d."status"::text AS "status", d."revisionsUsed",
      d."completedAt",
      EXISTS (
        SELECT 1 FROM "ServiceDealEvent" e
        WHERE e."dealId" = d."id" AND e."type" = 'Delivered'::"ServiceDealEventType"
          AND e."round" = d."revisionsUsed"
      ) AS "currentRoundDelivered"
    FROM "ServiceDeal" d WHERE d."id" = ${dealId}::int`;
  const isSeller = deal?.sellerId === userId;
  const isBuyer = deal?.buyerId === userId;
  if (!deal || (!isSeller && !isBuyer && !isModerator)) throw throwNotFoundError('Deal not found');

  const rows = await dbWrite.$queryRaw<FileRow[]>`
    SELECT f."id", f."round", f."kind", f."fileName", f."mimeType", f."size", f."deliverySize",
      f."status", f."failReason", f."scanStatus", f."malwareScanStatus", f."watermarkedKey",
      f."removedAt"
    FROM "ServiceDealFile" f
    WHERE f."dealId" = ${dealId}::int
    ORDER BY f."round", f."id"`;

  const privileged = isSeller || isModerator;
  // A removed file is for moderators who are not a party to the deal.
  const seesRemoved = isModerator && !isSeller && !isBuyer;
  return rows.flatMap((row): ListedFile[] => {
    if (row.removedAt) {
      if (!seesRemoved) return [];
      return [
        {
          id: row.id,
          round: row.round,
          kind: row.kind,
          fileName: row.fileName,
          mimeType: row.mimeType,
          size: row.size,
          status: row.status,
          failReason: row.failReason,
          scanStatus: row.scanStatus,
          previewUrl: null,
          canDownload: canReviewCsam,
          removedAt: row.removedAt,
        },
      ];
    }
    if (row.kind === 'Attachment') {
      // The buyer's file. The seller is not told it exists until its scans pass, and then gets what
      // a buyer gets of a Final: the delivery copy's size, no failure detail.
      // A moderator who is also the seller is the seller here.
      const owner = isBuyer || (isModerator && !isSeller);
      const cleared =
        row.status === 'Ready' && attachmentScansClear(row) && !CLOSED_TO_SELLER.has(deal.status);
      if (!owner && !cleared) return [];
      return [
        {
          id: row.id,
          round: row.round,
          kind: row.kind,
          fileName: row.fileName,
          mimeType: row.mimeType,
          size: owner ? row.size : row.deliverySize ?? row.size,
          status: row.status,
          failReason: owner ? row.failReason : null,
          scanStatus: row.scanStatus,
          previewUrl: null,
          canDownload: row.status === 'Ready' && (owner || cleared),
        },
      ];
    }

    const buyerOnly = !privileged;
    if (buyerOnly && !buyerSeesRound(deal, row.round)) return [];
    // A buyer sees a preview only once it is scanned, marked and published: never the original.
    if (buyerOnly && row.kind === 'Preview' && row.status !== 'Ready') return [];

    const downloadable =
      row.kind === 'Final' &&
      row.status === 'Ready' &&
      (privileged ||
        (buyerOwnsFinals(deal) && row.round === deal.revisionsUsed && finalScansClear(row)));
    const lockedFinal = buyerOnly && row.kind === 'Final' && !downloadable;
    const key = row.watermarkedKey;

    return [
      {
        id: row.id,
        round: row.round,
        kind: row.kind,
        // What the buyer has not paid for does not even get a name.
        fileName: lockedFinal ? null : row.fileName,
        mimeType: lockedFinal ? null : row.mimeType,
        // A buyer is told the size of what they will download.
        size: privileged ? row.size : row.deliverySize ?? row.size,
        status: row.status,
        failReason: privileged ? row.failReason : null,
        scanStatus: row.kind === 'Final' || privileged ? row.scanStatus : null,
        previewUrl:
          row.kind === 'Preview' && row.status === 'Ready' && key
            ? getEdgeUrl(key, { original: true, name: 'preview' })
            : null,
        canDownload: downloadable,
      },
    ];
  });
}

type ServiceDealFileAccess = {
  dealId: number;
  fileId: number;
  userId: number;
  role: ServiceDealAccessRole;
  kind: ServiceDealAccessKind;
};

export type ServiceDealFileDownload = {
  bucket: string;
  key: string;
  fileName: string;
  access: ServiceDealFileAccess;
  /** A removed file is signed only once its access is recorded. */
  removed: boolean;
};

/**
 * The object a user may download, or null (the route answers 404 for null, so a file id reveals
 * nothing). The seller may take back anything they uploaded; a moderator anything, for dispute
 * review; the buyer only a Final of the delivered round that has passed its scan, once they own it.
 * An Attachment reverses the roles: the buyer may take back their own, and the seller gets the
 * delivery copy only once its scans pass, and never after the deal is Declined, Expired or Cancelled.
 *
 * A buyer gets the delivery file, never the upload: for a zip that is the archive the server built,
 * and a zip without one is not downloadable by them at all. `delivered` asks a moderator for the
 * buyer's version instead of the original.
 */
export async function resolveServiceDealFileDownload({
  fileId,
  userId,
  isModerator,
  delivered = false,
  moderatorFetch = false,
  canReviewCsam = false,
}: {
  fileId: number;
  userId: number;
  isModerator: boolean;
  delivered?: boolean;
  /** The `csamReports` permission: a removed file is served only to a moderator who holds it. */
  canReviewCsam?: boolean;
  /** The moderator dispute tool. Recorded as a ModeratorFetch under the caller's role on the deal;
   *  it never counts as the buyer's download. */
  moderatorFetch?: boolean;
}): Promise<ServiceDealFileDownload | null> {
  const [row] = await dbWrite.$queryRaw<
    {
      dealId: number;
      s3Key: string;
      deliveryKey: string | null;
      fileName: string;
      kind: ServiceDealFileKind;
      round: number;
      scanStatus: ServiceDealFileScanStatus;
      malwareScanStatus: ServiceDealFileScanStatus;
      status: ServiceDealFileStatus;
      buyerId: number;
      sellerId: number;
      dealStatus: string;
      revisionsUsed: number;
      completedAt: Date | null;
      removedAt: Date | null;
    }[]
  >`
    SELECT f."dealId", f."s3Key", f."deliveryKey", f."fileName", f."kind", f."round", f."scanStatus",
      f."malwareScanStatus", f."status", f."removedAt",
      d."buyerId", d."sellerId", d."status"::text AS "dealStatus", d."revisionsUsed", d."completedAt"
    FROM "ServiceDealFile" f JOIN "ServiceDeal" d ON d."id" = f."dealId"
    WHERE f."id" = ${fileId}::int`;
  if (!row) return null;

  const isAttachment = row.kind === 'Attachment';
  const ready = row.status === 'Ready';
  const party = row.sellerId === userId || row.buyerId === userId;
  const allowed = row.removedAt
    ? canReviewCsam && isModerator && !party
    : isAttachment
    ? (isModerator && row.sellerId !== userId) ||
      (row.buyerId === userId && ready) ||
      (row.sellerId === userId &&
        ready &&
        attachmentScansClear(row) &&
        !CLOSED_TO_SELLER.has(row.dealStatus))
    : row.sellerId === userId
    ? // A refused or rejected upload is not served back, a seller who moderates included.
      row.status !== 'Failed'
    : isModerator ||
      (row.buyerId === userId &&
        row.kind === 'Final' &&
        ready &&
        row.round === row.revisionsUsed &&
        finalScansClear(row) &&
        buyerOwnsFinals({ status: row.dealStatus, completedAt: row.completedAt }));
  if (!allowed) return null;
  // A file never completed, or refused at completion, can still sit at the key its uploader holds
  // an upload URL for. Only the uploader is served those bytes (see `keepServerCopy`).
  const uploaderId = isAttachment ? row.buyerId : row.sellerId;
  if (isUploaderKey(row.s3Key) && userId !== uploaderId) return null;

  // The party receiving the file gets the copy the server built, never the upload.
  const receives = isAttachment
    ? row.sellerId === userId && row.buyerId !== userId
    : row.buyerId === userId && row.sellerId !== userId;
  const wantsDelivered = receives || (isModerator && delivered);
  let key = row.s3Key;
  if (wantsDelivered) {
    if (row.deliveryKey) key = row.deliveryKey;
    // An archive is only ever handed out in the form the server built.
    else if (fileExtension(row.fileName) === 'zip') return null;
  }
  const role: ServiceDealAccessRole =
    row.sellerId === userId ? 'Seller' : row.buyerId === userId ? 'Buyer' : 'Moderator';
  return {
    bucket: await getBucket(),
    key,
    removed: !!row.removedAt,
    fileName: row.fileName,
    access: {
      dealId: row.dealId,
      fileId,
      userId,
      role,
      kind: moderatorFetch ? 'ModeratorFetch' : 'Download',
    },
  };
}

/** Not awaited, so recording never slows or fails a download; it still awaits delivery so a lost
 *  row is logged. A removed file is the exception: it is not signed unless the access was recorded. */
export async function getServiceDealFileDownloadUrl(
  target: ServiceDealFileDownload,
  tracker: Pick<Tracker, 'serviceDealFileAccess'>
) {
  if (target.removed) {
    const sent = await Promise.resolve()
      .then(() => tracker.serviceDealFileAccess(target.access, { awaitDelivery: true }))
      .catch((error: unknown) => {
        logAccessFailure(target.access)(error);
        return null;
      });
    if (sent === false) logAccessFailure(target.access)(new Error('Tracker not configured'));
    if (!sent) throw throwServiceUnavailableError('This file cannot be downloaded right now.');
    return signDownload(target);
  }
  const url = await signDownload(target);
  try {
    tracker
      .serviceDealFileAccess(target.access, { awaitDelivery: true })
      .then((sent) => {
        // False is a tracker that is switched off: nothing was written.
        if (!sent) logAccessFailure(target.access)(new Error('Tracker not configured'));
      })
      .catch(logAccessFailure(target.access));
  } catch (error) {
    logAccessFailure(target.access)(error);
  }
  return url;
}

const signDownload = async (target: ServiceDealFileDownload) =>
  (
    await getGetUrlByKey(target.key, {
      bucket: target.bucket,
      fileName: target.fileName,
      expiresIn: SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS,
    })
  ).url;

const logAccessFailure = (access: ServiceDealFileAccess) => (error: unknown) =>
  logToAxiom({
    name: 'creator-service-file-access',
    type: 'error',
    message: 'Could not record a deal file access',
    ...access,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => null);

// ---------------------------------------------------------------------------------------------
// Preview pipeline (the job)
// ---------------------------------------------------------------------------------------------
//
// A preview is scanned BEFORE it is marked:
//   1. a hidden, downscaled, unwatermarked copy goes to the image store and through the normal
//      image scan (`startPreviewScans`);
//   2. the verdict lands on the file (`settlePreviewScans`): clean passes it, anything else fails
//      it for good;
//   3. only a passed preview is marked and published (`publishPreviews`), then Ready;
//   4. the hidden copy and its Image row are deleted once the preview passed (`deleteScanCopies`);
//      a rejected preview's copy is kept for moderation.
// Each step is claimed per file and idempotent, so a pod that rolls mid-way leaves the file where
// the next run picks it up, with no second ingest and no copy left behind.

type ClaimedPreview = {
  id: number;
  s3Key: string;
  scanKey: string | null;
  sellerId: number;
};

/** Takes the previews matching `where` that no run holds, oldest first. */
function claimPreviews(where: Prisma.Sql, limit: number) {
  return dbWrite.$queryRaw<ClaimedPreview[]>`
    UPDATE "ServiceDealFile" f SET "processingAt" = now()
    FROM "ServiceDeal" d
    WHERE d."id" = f."dealId" AND f."id" IN (
      SELECT p."id" FROM "ServiceDealFile" p
      WHERE p."kind" = 'Preview'::"ServiceDealFileKind"
        AND p."status" = 'Processing'::"ServiceDealFileStatus"
        AND ${where} AND ${liveFile(Prisma.sql`p`)}
        AND (p."processingAt" IS NULL
          OR p."processingAt" < now() - (${SERVICE_PREVIEW_PROCESSING_STALE_MS}::int * interval '1 millisecond'))
      ORDER BY p."id" LIMIT ${limit}::int FOR UPDATE SKIP LOCKED)
    RETURNING f."id", f."s3Key", f."scanKey", d."sellerId"`;
}

export async function readObject(bucket: string, key: string) {
  const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error('Empty object body');
  return Buffer.from(await response.Body.transformToByteArray());
}

const logPreview = (message: string, fields: Record<string, unknown>, type = 'info') =>
  logToAxiom({ name: 'creator-service-preview', type, message, ...fields }).catch(() => null);

/** A seller-fixable problem fails the file with its reason; anything else is retried when stale. */
async function failOrRetry(preview: ClaimedPreview, error: unknown) {
  if (error instanceof PreviewRejectedError) return failFile(preview.id, error.message);
  logPreview(
    'preview step failed; it will be retried',
    { fileId: preview.id, error: (error as Error)?.message },
    'error'
  );
}

/**
 * A bare Image row, scanned like any upload: no post, no feed, ingestion NOT skipped. The caller
 * records its id on the file so the copy can be found and deleted.
 */
export async function createScanImage(
  url: string,
  copy: { mimeType: string; width: number; height: number; data: Buffer },
  userId: number
) {
  const { createImage } = await import('~/server/services/image.service');
  return createImage({
    url,
    type: 'image',
    mimeType: copy.mimeType,
    width: copy.width,
    height: copy.height,
    metadata: { size: copy.data.byteLength },
    userId,
  });
}

/** Step 1: the hidden scan copy, for previews that have none yet. */
export async function startPreviewScans({ limit = 5 } = {}) {
  const claimed = await claimPreviews(
    Prisma.sql`p."scanStatus" = 'Pending'::"ServiceDealFileScanStatus" AND p."imageId" IS NULL`,
    limit
  );
  let started = 0;
  for (const preview of claimed) {
    const began = Date.now();
    try {
      let frames = 0;
      let imageId: number | undefined;
      if (preview.scanKey) {
        // A crash left the object, and maybe the Image row: find it so it is never ingested twice.
        const [existing] = await dbWrite.$queryRaw<{ id: number }[]>`
          SELECT "id" FROM "Image" WHERE "url" = ${preview.scanKey}::text LIMIT 1`;
        imageId = existing?.id;
      }
      if (!imageId) {
        const original = await readObject(await getBucket(), preview.s3Key);
        const copy = await buildScanCopy(original);
        frames = copy.frames;
        let scanKey = preview.scanKey;
        if (!scanKey) {
          ({ key: scanKey } = await uploadImageBufferToStore(copy.data, {
            contentType: copy.mimeType,
          }));
          // Recorded before the Image row exists, so a retry after a crash reuses this object.
          await dbWrite.$executeRaw`
            UPDATE "ServiceDealFile" SET "scanKey" = ${scanKey}::text WHERE "id" = ${preview.id}::int`;
        }
        imageId = (await createScanImage(scanKey, copy, preview.sellerId)).id;
      }
      // By id alone: a preview removed while its copy was made is kept, and keeps the copy too.
      await dbWrite.$executeRaw`
        UPDATE "ServiceDealFile" SET "imageId" = ${imageId}::int, "processingAt" = NULL
        WHERE "id" = ${preview.id}::int`;
      started++;
      logPreview('scan copy submitted', { fileId: preview.id, frames, ms: Date.now() - began });
    } catch (error) {
      await failOrRetry(preview, error);
    }
  }
  return started;
}

/**
 * Step 2: the scan's verdict. Clean passes the preview (to be marked next); a block, or any flag
 * that sends an image to review, fails it. A scan that could not run fails the file without
 * calling its content bad, and one that never settles is given up on.
 */
export async function settlePreviewScans() {
  const waiting = Prisma.sql`f."kind" = 'Preview'::"ServiceDealFileKind"
    AND f."status" = 'Processing'::"ServiceDealFileStatus"
    AND f."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"`;
  const passed = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" f
    SET "scanStatus" = 'Passed'::"ServiceDealFileScanStatus", "processingAt" = NULL,
      "nsfwLevel" = i."nsfwLevel"
    FROM "Image" i
    WHERE i."id" = f."imageId" AND ${waiting}
      AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"
      AND i."needsReview" IS NULL AND NOT i."poi" AND NOT i."minor"
      AND i."nsfwLevel" BETWEEN 1 AND ${SERVICE_PREVIEW_MAX_NSFW_LEVEL}::int`;
  const rejected = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" f
    SET "status" = 'Failed'::"ServiceDealFileStatus", "scanStatus" = 'Failed'::"ServiceDealFileScanStatus",
      "failReason" = 'This preview was rejected when it was checked.'
    FROM "Image" i
    WHERE i."id" = f."imageId" AND ${waiting}
      AND (i."ingestion" = 'Blocked'::"ImageIngestionStatus"
        OR (i."ingestion" = 'Scanned'::"ImageIngestionStatus"
          AND (i."needsReview" IS NOT NULL OR i."poi" OR i."minor"
            OR i."nsfwLevel" > ${SERVICE_PREVIEW_MAX_NSFW_LEVEL}::int)))`;
  const unchecked = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" f
    SET "status" = 'Failed'::"ServiceDealFileStatus",
      "failReason" = 'This preview could not be checked. Upload it again.'
    FROM "Image" i
    WHERE i."id" = f."imageId" AND ${waiting}
      AND i."ingestion" = 'NotFound'::"ImageIngestionStatus"`;
  const timedOut = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "status" = 'Failed'::"ServiceDealFileStatus",
      "failReason" = 'This preview could not be prepared. Upload it again.'
    WHERE "kind" = 'Preview'::"ServiceDealFileKind" AND "status" = 'Processing'::"ServiceDealFileStatus"
      AND "uploadedAt" < now() - (${SERVICE_PREVIEW_GIVE_UP_MS}::int * interval '1 millisecond')`;
  return { passed, rejected, unchecked, timedOut };
}

/** Step 3: mark and publish the previews that passed. Ready only when the mark is on. */
export async function publishPreviews({ limit = 5 } = {}) {
  const claimed = await claimPreviews(
    Prisma.sql`p."scanStatus" = 'Passed'::"ServiceDealFileScanStatus" AND p."watermarkedKey" IS NULL`,
    limit
  );
  let published = 0;
  for (const preview of claimed) {
    const began = Date.now();
    try {
      const original = await readObject(await getBucket(), preview.s3Key);
      const result = await buildWatermarkedPreview(original);
      const { key } = await uploadImageBufferToStore(result.data, { contentType: result.mimeType });
      await dbWrite.$executeRaw`
        UPDATE "ServiceDealFile"
        SET "watermarkedKey" = ${key}::text, "status" = 'Ready'::"ServiceDealFileStatus"
        WHERE "id" = ${preview.id}::int AND "status" = 'Processing'::"ServiceDealFileStatus"
          AND "scanStatus" = 'Passed'::"ServiceDealFileScanStatus"`;
      published++;
      logPreview('preview published', {
        fileId: preview.id,
        frames: result.frames,
        inputBytes: original.byteLength,
        outputBytes: result.data.byteLength,
        ms: Date.now() - began,
      });
    } catch (error) {
      await failOrRetry(preview, error);
    }
  }
  return published;
}

/**
 * Step 4: a scan copy has done its job once its file passed, or failed for a reason that is not a
 * verdict on the content. Deleting the Image row removes the object too; a delete that fails stays
 * pointed at and is retried. The copy of a REJECTED preview is kept: its Image row is what the
 * moderation tooling reads, and deleting it would take the evidence with it.
 */
export async function deleteScanCopies({ limit = 50 } = {}) {
  const rows = await dbWrite.$queryRaw<{ id: number; imageId: number }[]>`
    SELECT "id", "imageId" FROM "ServiceDealFile"
    WHERE "imageId" IS NOT NULL
      AND ("scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
        OR ("scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
          AND "status" = 'Failed'::"ServiceDealFileStatus"))
    ORDER BY "id" LIMIT ${limit}::int`;
  if (!rows.length) return 0;
  const { deleteImageById } = await import('~/server/services/image.service');
  let deleted = 0;
  for (const row of rows) {
    try {
      await deleteImageById({ id: row.imageId, updatePost: false });
      await dbWrite.$executeRaw`
        UPDATE "ServiceDealFile" SET "imageId" = NULL, "scanKey" = NULL WHERE "id" = ${row.id}::int`;
      deleted++;
    } catch (error) {
      logPreview(
        'scan copy delete failed; it will be retried',
        { fileId: row.id, imageId: row.imageId, error: (error as Error)?.message },
        'error'
      );
    }
  }
  return deleted;
}
