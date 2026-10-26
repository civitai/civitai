import { Prisma } from '@prisma/client';
import { CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { holdServiceDealForReview } from '~/server/services/creator-service-escrow.service';
import { transitionDeal } from '~/server/services/creator-service-deal.service';
import { dealReadyToDeliver } from '~/server/services/creator-service-deal-file-sql';
import { isFinalsMalwareScanOn } from '~/server/services/creator-service-deal-file-scan';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  buildScanCopy,
  buildWatermarkedPreview,
  PreviewRejectedError,
} from '~/server/utils/service-deal-preview';
import {
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
  ServiceDealAccessKind,
  ServiceDealAccessRole,
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
 */

/** Statuses a seller may upload in. */
const WORKING = Prisma.sql`'Accepted'::"ServiceDealStatus", 'InRevision'::"ServiceDealStatus"`;

const UPLOAD_KEY_ROOT = 'service-deals';

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
  kind: ServiceDealFileKind;
  fileName: string;
  mimeType: string;
  size: number;
}) {
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
    assertFinalFileType(fileName);
    if (size > SERVICE_FINAL_MAX_BYTES)
      throw throwBadRequestError('That file is too large to deliver.');
    // An image is scanned whole, so it has its own, lower, cap.
    if (
      (SERVICE_ZIP_IMAGE_EXTENSIONS as readonly string[]).includes(
        fileExtension(cleanFileName(fileName))
      ) &&
      size > SERVICE_ZIP_MAX_IMAGE_BYTES
    )
      throw throwBadRequestError(
        `An image cannot be more than ${Math.floor(
          SERVICE_ZIP_MAX_IMAGE_BYTES / (1024 * 1024)
        )} MB.`
      );
  }

  const created = await dbWrite.$transaction(async (tx) => {
    // Lock the deal row so two uploads cannot both pass the count below.
    const [deal] = await tx.$queryRaw<UploadDealRow[]>`
      SELECT d."id", d."revisionsUsed" AS "round", d."previewKind",
        (SELECT count(*)::int FROM "ServiceDealFile" f
          WHERE f."dealId" = d."id" AND f."round" = d."revisionsUsed"
            AND f."kind" = ${kind}::"ServiceDealFileKind") AS "files"
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

/** The seller's own file in a deal still being worked, or null. */
async function findSellerFile(fileId: number, userId: number) {
  const [file] = await dbWrite.$queryRaw<OwnedFileRow[]>`
    SELECT f."id", f."dealId", f."round", f."kind", f."s3Key", f."fileName", f."mimeType", f."size",
      f."status", f."imageId"
    FROM "ServiceDealFile" f JOIN "ServiceDeal" d ON d."id" = f."dealId"
    WHERE f."id" = ${fileId}::int AND d."sellerId" = ${userId}::int
      AND d."status" IN (${WORKING}) AND f."round" = d."revisionsUsed"`;
  return file ?? null;
}

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

/**
 * The seller says the bytes are in the bucket. The seller holds a long-lived upload URL for the key
 * they were given, so nothing they could still write to is trusted: the object is COPIED to a key
 * only the server ever has, and every check here, and every later read, is of that copy. A size
 * that is not the declared one fails the file and removes both objects.
 */
export async function completeServiceDealUpload({
  fileId,
  userId,
}: {
  fileId: number;
  userId: number;
}) {
  const file = await findSellerFile(fileId, userId);
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

  // The copy is what gets measured. The seller can no longer change it.
  const held = await headObject(bucket, heldKey);
  if (held.status === 'unknown') throw couldNotCheck();
  if (held.status === 'absent' || held.size !== file.size) {
    const reason = 'The uploaded file did not match its declared size.';
    if ((await failFile(file.id, reason, 'Uploading')) === 0) return currentState(file.id);
    await deleteObject(bucket, file.s3Key).catch(() => null);
    await deleteObject(bucket, heldKey).catch(() => null);
    throw throwBadRequestError(reason);
  }

  if (file.kind === 'Final' && fileExtension(file.fileName) === 'zip') {
    const refusal = await zipRefusal(bucket, heldKey);
    if (refusal) {
      if ((await failFile(file.id, refusal, 'Uploading')) === 0) return currentState(file.id);
      await deleteObject(bucket, file.s3Key).catch(() => null);
      await deleteObject(bucket, heldKey).catch(() => null);
      throw throwBadRequestError(refusal);
    }
  }

  // A preview is processed by the job; a final is ready now and is unpacked by the job.
  const next: ServiceDealFileStatus = file.kind === 'Preview' ? 'Processing' : 'Ready';
  const moved = await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "status" = ${next}::"ServiceDealFileStatus", "uploadedAt" = now(), "s3Key" = ${heldKey}::text
    WHERE "id" = ${file.id}::int AND "status" = 'Uploading'::"ServiceDealFileStatus"`;
  // The seller's key is dead either way. A repeat call that lost the race removes its own copy.
  await deleteObject(bucket, moved === 1 ? file.s3Key : heldKey).catch(() => null);
  return { id: file.id, status: next };
}

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
export async function deleteServiceDealFile({
  fileId,
  userId,
}: {
  fileId: number;
  userId: number;
}) {
  const removed = await dbWrite.$transaction(async (tx) => {
    const [deal] = await tx.$queryRaw<{ id: number }[]>`
      SELECT d."id" FROM "ServiceDeal" d JOIN "ServiceDealFile" f ON f."dealId" = d."id"
      WHERE f."id" = ${fileId}::int AND d."sellerId" = ${userId}::int
        AND d."status" IN (${WORKING})
      FOR UPDATE OF d`;
    if (!deal) throw throwNotFoundError('File not found');
    // Re-read under the lock: the state above is the one that is true now.
    // An image that passed has no more use for its copy. One still being scanned, or rejected, keeps
    // its copy and its row (detached from the file): that is what the moderators would need.
    const copies = await tx.$queryRaw<{ imageId: number }[]>`
      SELECT e."imageId" FROM "ServiceDealFileEntry" e
      WHERE e."fileId" = ${fileId}::int AND e."imageId" IS NOT NULL
        AND e."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
      FOR UPDATE OF e`;
    await tx.$executeRaw`
      DELETE FROM "ServiceDealFileEntry" e
      WHERE e."fileId" = ${fileId}::int
        AND (e."imageId" IS NULL OR e."scanStatus" = 'Passed'::"ServiceDealFileScanStatus")`;
    const [file] = await tx.$queryRaw<
      {
        id: number;
        s3Key: string;
        deliveryKey: string | null;
        imageId: number | null;
        scanKey: string | null;
      }[]
    >`
      DELETE FROM "ServiceDealFile" f USING "ServiceDeal" d
      WHERE f."id" = ${fileId}::int AND d."id" = f."dealId" AND f."round" = d."revisionsUsed"
        AND d."status" IN (${WORKING})
      RETURNING f."id", f."s3Key", f."deliveryKey", f."imageId", f."scanKey"`;
    if (!file) throw throwNotFoundError('File not found');
    return { ...file, copies };
  });

  // The row is the source of truth; an object left behind is unreachable and harmless.
  const bucket = await getBucket();
  await deleteObject(bucket, removed.s3Key).catch(() => null);
  if (removed.deliveryKey) await deleteObject(bucket, removed.deliveryKey).catch(() => null);
  if (removed.imageId) {
    // A preview deleted mid-scan: its hidden copy goes with it.
    const { deleteImageById } = await import('~/server/services/image.service');
    await deleteImageById({ id: removed.imageId, updatePost: false }).catch(() => null);
  }
  if (removed.copies.length) {
    const { deleteImageById } = await import('~/server/services/image.service');
    for (const { imageId } of removed.copies)
      await deleteImageById({ id: imageId, updatePost: false }).catch(() => null);
  }
  return { id: removed.id };
}

/**
 * Records a verdict on a Final. Only a Pending Final takes one, so a repeat or late result cannot
 * overturn an earlier one. Passed also needs the file unpacked and ready, never refused, its malware
 * scan passed (or skipped while the scan is off) and every image passed. A Failed Final sends a
 * delivered deal to the moderators; one not yet delivered cannot be delivered while it stands (see `dealReadyToDeliver`).
 */
export async function recordFinalScanResult({
  fileId,
  verdict,
}: {
  fileId: number;
  verdict: 'Passed' | 'Failed';
}) {
  // A skipped malware scan stands in for a passed one only while the scan is off, so turning it on
  // stops passing the Finals it skipped until they are scanned (see `settleFinals`).
  const malwareScanOn = verdict === 'Passed' ? await isFinalsMalwareScanOn() : true;
  const [file] = await dbWrite.$queryRaw<{ dealId: number }[]>`
    UPDATE "ServiceDealFile" SET "scanStatus" = ${verdict}::"ServiceDealFileScanStatus"
    WHERE "id" = ${fileId}::int AND "kind" = 'Final'::"ServiceDealFileKind"
      AND "scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND (${verdict}::text = 'Failed' OR (
        "unpackedAt" IS NOT NULL
        AND "repackedAt" IS NOT NULL
        AND "failReason" IS NULL
        AND ("malwareScanStatus" = 'Passed'::"ServiceDealFileScanStatus"
          OR ("malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus" AND NOT ${malwareScanOn}))
        AND NOT EXISTS (
          SELECT 1 FROM "ServiceDealFileEntry" e
          WHERE e."fileId" = "ServiceDealFile"."id"
            AND e."scanStatus" <> 'Passed'::"ServiceDealFileScanStatus")))
    RETURNING "dealId"`;
  if (!file) return { recorded: false, held: false };
  const held =
    verdict === 'Failed'
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
}: {
  dealId: number;
  userId: number;
  isModerator: boolean;
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
      f."status", f."failReason", f."scanStatus", f."malwareScanStatus", f."watermarkedKey"
    FROM "ServiceDealFile" f
    WHERE f."dealId" = ${dealId}::int
    ORDER BY f."round", f."id"`;

  const privileged = isSeller || isModerator;
  return rows.flatMap((row) => {
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
};

/**
 * The object a user may download, or null (the route answers 404 for null, so a file id reveals
 * nothing). The seller may take back anything they uploaded; a moderator anything, for dispute
 * review; the buyer only a Final of the delivered round that has passed its scan, once they own it.
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
}: {
  fileId: number;
  userId: number;
  isModerator: boolean;
  delivered?: boolean;
  /** The moderator dispute tool, recorded apart from a party's own download even on their own deal. */
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
    }[]
  >`
    SELECT f."dealId", f."s3Key", f."deliveryKey", f."fileName", f."kind", f."round", f."scanStatus",
      f."malwareScanStatus", f."status",
      d."buyerId", d."sellerId", d."status"::text AS "dealStatus", d."revisionsUsed", d."completedAt"
    FROM "ServiceDealFile" f JOIN "ServiceDeal" d ON d."id" = f."dealId"
    WHERE f."id" = ${fileId}::int`;
  if (!row) return null;

  const allowed =
    row.sellerId === userId ||
    isModerator ||
    (row.buyerId === userId &&
      row.kind === 'Final' &&
      row.status === 'Ready' &&
      row.round === row.revisionsUsed &&
      finalScansClear(row) &&
      buyerOwnsFinals({ status: row.dealStatus, completedAt: row.completedAt }));
  if (!allowed) return null;

  const isBuyer = row.buyerId === userId && row.sellerId !== userId;
  const wantsDelivered = isBuyer || (isModerator && delivered);
  let key = row.s3Key;
  if (wantsDelivered) {
    if (row.deliveryKey) key = row.deliveryKey;
    // An archive is only ever handed out in the form the server built.
    else if (fileExtension(row.fileName) === 'zip') return null;
  }
  const role: ServiceDealAccessRole =
    moderatorFetch || (row.sellerId !== userId && row.buyerId !== userId)
      ? 'Moderator'
      : row.sellerId === userId
      ? 'Seller'
      : 'Buyer';
  return {
    bucket: await getBucket(),
    key,
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

/** Signs the link and records who took it. The record is dispute evidence but never worth a failed
 *  or slower download, so it is not awaited and a failure is only logged. */
export async function getServiceDealFileDownloadUrl(target: ServiceDealFileDownload) {
  const { url } = await getGetUrlByKey(target.key, {
    bucket: target.bucket,
    fileName: target.fileName,
    expiresIn: SERVICE_FILE_DOWNLOAD_EXPIRY_SECONDS,
  });
  void recordServiceDealFileAccess(target.access);
  return url;
}

async function recordServiceDealFileAccess(access: ServiceDealFileAccess) {
  try {
    await dbWrite.$executeRaw`
      INSERT INTO "ServiceDealFileAccess" ("dealId", "fileId", "userId", "role", "kind")
      VALUES (${access.dealId}::int, ${access.fileId}::int, ${access.userId}::int,
        ${access.role}::"ServiceDealAccessRole", ${access.kind}::"ServiceDealAccessKind")`;
  } catch (error) {
    logToAxiom({
      name: 'creator-service-file-access',
      type: 'error',
      message: 'Could not record a deal file access',
      ...access,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
  }
}

export type ServiceDealFileAccessSummary = {
  dealId: number;
  fileId: number;
  role: ServiceDealAccessRole;
  kind: ServiceDealAccessKind;
  count: number;
  firstAt: Date;
  lastAt: Date;
};

/** Every recorded access to the given deals' files, one row per file, role and kind. */
export async function listServiceDealFileAccess(dealIds: number[]) {
  if (!dealIds.length) return [];
  return dbWrite.$queryRaw<ServiceDealFileAccessSummary[]>`
    SELECT "dealId", "fileId", "role", "kind", count(*)::int AS "count",
      min("createdAt") AS "firstAt", max("createdAt") AS "lastAt"
    FROM "ServiceDealFileAccess"
    WHERE "dealId" = ANY(${dealIds}::int[])
    GROUP BY "dealId", "fileId", "role", "kind"
    ORDER BY "dealId", "fileId", "role", "kind"`;
}

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
        AND ${where}
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
