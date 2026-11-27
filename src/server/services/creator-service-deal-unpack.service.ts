import { GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { constants } from '~/server/common/constants';
import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import {
  entryImageGone,
  SCANNED_FILE_KINDS,
} from '~/server/services/creator-service-deal-file-sql';
import { logToAxiom } from '~/server/logging/client';
import {
  acceptedAsVideo,
  getFinalScanReading,
  isFinalsMalwareScanOn,
  submitFinalScan,
  type FinalScanTarget,
} from '~/server/services/creator-service-deal-file-scan';
import {
  createScanImage,
  fileExtension,
  isFinalVideoName,
  readObject,
  recordFinalScanResult,
  markCopyDeletes,
  releaseEntryCopies,
  settleCopyDeletes,
  findScanCopyImageId,
} from '~/server/services/creator-service-deal-file.service';
import { probeVideoDimensions } from '~/server/services/video-dimensions';
import { readVideoLengths } from '~/server/utils/video-lengths';
import { buildEntryScanCopy, PreviewRejectedError } from '~/server/utils/service-deal-preview';
import {
  openZip,
  readEntry,
  openEntryStream,
  s3ZipSource,
  id3TagLength,
  listZipPaths,
  MAX_ID3_TAGS,
  everyEntryHead,
  holdsPdfHeader,
  PDF_HEADER_WINDOW,
  isMediaName,
  sniffEntry,
  SNIFF_BYTES,
  ZipRejectedError,
  type OpenedZip,
  type ZipEntry,
} from '~/server/utils/service-deal-zip';
import {
  SERVICE_FINAL_OVER_LEVEL_REASON,
  SERVICE_FINAL_PDF_REFUSAL,
  SERVICE_FINAL_SCAN_GIVE_UP_MS,
  SERVICE_FINAL_VIDEO_EXTENSIONS,
  SERVICE_FINAL_VIDEO_LENGTH_UNCLEAR,
  SERVICE_FINAL_VIDEO_TOO_LONG,
  SERVICE_FINAL_SCAN_MAX_ATTEMPTS,
  SERVICE_FINAL_SCAN_RETRY_MS,
  SERVICE_FINAL_SCAN_STALE_MS,
  SERVICE_UNPACK_RETRY_MS,
  SERVICE_UNPACK_STALE_MS,
  SERVICE_ZIP_IMAGE_EXTENSIONS,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
  SERVICE_ZIP_MODEL_EXTENSIONS,
} from '~/shared/constants/creator-services.constants';
import {
  deleteObject,
  getBucket,
  getImageUploadBackend,
  getS3Client,
  uploadImageBufferToStore,
} from '~/utils/s3-utils';

/**
 * Unpacks the Finals of a deal and sends every image in them through the normal image scan.
 * A buyer's Attachment takes the same path, with its image copies created as the buyer's.
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
  logToAxiom({ name: 'creator-service-unpack', type, message, ...fields });

/** The highest rating an image in a Final may carry: the deal's own. */
const MAX_LEVEL = Prisma.sql`d."maxNsfwLevel"`;

type ClaimedFinal = {
  id: number;
  dealId: number;
  s3Key: string;
  fileName: string;
  size: number;
  kind: string;
  /** Who uploaded the file: the image scan copies are created as theirs. */
  uploaderId: number;
};

const isImageName = (name: string) =>
  (SERVICE_ZIP_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(name));

/**
 * Takes the one Final or Attachment that no run holds and that has not been unpacked, oldest first.
 * A removed one is taken too, so a kept file still gets its verdict.
 */
function claimFinal() {
  return dbWrite.$queryRaw<ClaimedFinal[]>`
    UPDATE "ServiceDealFile" f SET "processingAt" = now()
    FROM "ServiceDeal" d
    WHERE d."id" = f."dealId" AND f."id" IN (
      SELECT p."id" FROM "ServiceDealFile" p
      WHERE p."kind"::text IN (${SCANNED_FILE_KINDS})
        AND p."status" = 'Ready'::"ServiceDealFileStatus"
        AND p."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
        AND p."unpackedAt" IS NULL
        AND (p."processingAt" IS NULL
          OR p."processingAt" < now() - (${SERVICE_UNPACK_STALE_MS}::int * interval '1 millisecond'))
      ORDER BY p."id" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING f."id", f."dealId", f."s3Key", f."fileName", f."size", f."kind"::text AS "kind",
      CASE WHEN f."kind"::text = 'Attachment' THEN d."buyerId" ELSE d."sellerId" END
        AS "uploaderId"`;
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
  uploaderId: number
) {
  const [row] = await dbWrite.$queryRaw<EntryRow[]>`
    SELECT "id", "dealId", "path", "size", "imageId", "scanKey", "scanStatus"::text AS "scanStatus"
    FROM "ServiceDealFileEntry"
    WHERE "fileId" = ${fileId}::int AND "entryIndex" = ${entryIndex}::int`;
  // An image already submitted, or already judged and its copy deleted, is never ingested again.
  if (!row || row.imageId || row.scanStatus !== 'Pending') return;

  // A crash left the object, and maybe the Image row.
  let imageId = row.scanKey ? await findScanCopyImageId(row.scanKey) : undefined;
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
    imageId = (await createScanImage(scanKey, copy, uploaderId)).id;
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
    // A second read, on a budget of its own, so the archive's total is not counted twice. readEntry
    // has already inflated this whole entry against the archive's limits, so this reads nothing the
    // archive was not allowed, and the entry's own cap still applies.
    else if (
      !(await isTheDocumentItsNamed(entry.path, {
        open: () => openEntryStream(zipfile, entry, { used: 0 }),
      }))
    )
      throw new ZipRejectedError("A document in the archive isn't what its name says.");
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
        await submitEntryImage(file.id, entry.index, read.data!, file.uploaderId);
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

const isZipStart = (head: Buffer) => head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]));
const isPickle = (head: Buffer) => head[0] === 0x80 && head[1] >= 2 && head[1] <= 5;

/** What each model format begins with. Anything else under a model name is not that model. */
const MODEL_FORMATS: Record<string, (head: Buffer) => boolean> = {
  // An 8-byte little-endian header length, then the JSON header.
  safetensors: (head) =>
    head.length >= 9 && head.readBigUInt64LE(0) < BigInt(100 * 1024 * 1024) && head[8] === 0x7b,
  gguf: (head) => head.subarray(0, 4).toString('latin1') === 'GGUF',
  // A protobuf ModelProto opens with field 1 (ir_version) as a varint.
  onnx: (head) => head[0] === 0x08,
  // A torch checkpoint is a zip in torch's layout, or a pickle from before it.
  pt: (head) => isZipStart(head) || isPickle(head),
  pth: (head) => isZipStart(head) || isPickle(head),
  ckpt: (head) => isZipStart(head) || isPickle(head),
  bin: (head) => isZipStart(head) || isPickle(head),
};

/** What each audio format begins with, past any ID3v2 tags (already read past by `readHead`). */
const AUDIO_FORMATS: Record<string, (head: Buffer) => boolean> = {
  mp3: (head) => head[0] === 0xff && (head[1] & 0xe0) === 0xe0,
  // RF64 and BW64 are the 64-bit-size forms broadcast tools write for long recordings.
  wav: (head) =>
    ['RIFF', 'RF64', 'BW64'].includes(head.subarray(0, 4).toString('latin1')) &&
    head.subarray(8, 12).toString('latin1') === 'WAVE',
  flac: (head) => head.subarray(0, 4).toString('latin1') === 'fLaC',
  ogg: (head) => head.subarray(0, 4).toString('latin1') === 'OggS',
};

/** Entries torch.save and torch.jit.save write, all under one root folder. */
const TORCH_ENTRY =
  /^[^/]+\/(data\.pkl|constants\.pkl|attributes\.pkl|version|byteorder|\.format_version|\.storage_alignment|serialization_id|\.data\/(serialization_id|version)|(data|constants)\/\d+|code\/__torch__(\/.+)?\.(py|pkl|py\.debug_pkl)|extra\/.+)$/;
const TORCH_MAX_ENTRIES = 50_000;
/** Tensor storage: torch.save's data/N and torch.jit.save's constants/N. */
const TORCH_TENSOR = /^[^/]+\/(data|constants)\/\d+$/;
/** An icon's header, which tensor bytes (a zero then a one) can start with. */
const ICON_LIKE = Buffer.from([0, 0, 1, 0]);

async function isTorchArchive(file: ClaimedFinal) {
  const source = s3ZipSource(getS3Client(), await getBucket(), file.s3Key, file.size);
  const paths = await listZipPaths(source, TORCH_MAX_ENTRIES);
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  if (
    roots.size !== 1 ||
    !paths.some((path) => /^[^/]+\/data\.pkl$/.test(path)) ||
    !paths.every((path) => path.endsWith('/') || TORCH_ENTRY.test(path))
  )
    return false;
  // Unzipped, every entry is a file of its own, and the archive is delivered without its images
  // being scanned: none may be a picture, a video or an archive. Tensor bytes are opaque, so a
  // stream is looked for only where a file of one would start, and only the image formats a
  // viewer opens are refused.
  return everyEntryHead(source, TORCH_MAX_ENTRIES, (path, head) => {
    if (isMediaName(path)) return false;
    const tensor = TORCH_TENSOR.test(path);
    const kind = sniffEntry(head, { tsAnywhere: !tensor });
    return (
      kind === 'other' ||
      (tensor && kind === 'unscannable' && head.subarray(0, 4).equals(ICON_LIKE))
    );
  });
}

/** The Final's first bytes as stored, before any tag a player would skip. */
async function readRawPrefix(file: ClaimedFinal) {
  if (file.size === 0) return Buffer.alloc(0);
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: await getBucket(),
      Key: file.s3Key,
      Range: `bytes=0-${Math.min(PDF_HEADER_WINDOW, file.size) - 1}`,
    })
  );
  if (!response.Body) throw new Error('Empty object body');
  return Buffer.from(await response.Body.transformToByteArray());
}

/** The Final's first bytes past any leading ID3v2 tags, which a player skips to play what follows. */
async function readHead(file: ClaimedFinal) {
  let offset = 0;
  for (let tags = 0; ; tags++) {
    if (offset >= file.size) return Buffer.alloc(0);
    const response = await getS3Client().send(
      new GetObjectCommand({
        Bucket: await getBucket(),
        Key: file.s3Key,
        Range: `bytes=${offset}-${offset + SNIFF_BYTES - 1}`,
      })
    );
    if (!response.Body) throw new Error('Empty object body');
    const head = Buffer.from(await response.Body.transformToByteArray());
    const tag = tags < MAX_ID3_TAGS ? id3TagLength(head) : 0;
    if (!tag) return head;
    offset += tag;
  }
}

/** Counted by claimed type, so false refusals show up after release. */
const notItsFormat = (kind: 'model' | 'audio' | 'document', extension: string) => {
  logUnpack('final is not its claimed format', { payload: { kind, extension } }, 'warning').catch(
    () => null
  );
  return new ZipRejectedError(`This file doesn't look like a .${extension} ${kind} file.`);
};

const isModelName = (name: string) =>
  (SERVICE_ZIP_MODEL_EXTENSIONS as readonly string[]).includes(fileExtension(name));

/**
 * A Final that is not an archive is judged by its first bytes past any ID3 tags, not its name: an
 * image or a video called notes.txt is still one. A Final named as a model or audio file must also
 * begin like that format, and a zip under a model name must be in torch's layout. Returns whether
 * it is an image.
 */
async function isImageByContent(file: ClaimedFinal) {
  const head = await readHead(file);
  const kind = sniffEntry(head);
  if (kind === 'pdf') throw new ZipRejectedError(SERVICE_FINAL_PDF_REFUSAL);
  if (kind === 'video')
    throw new ZipRejectedError(
      file.kind === 'Attachment'
        ? "Videos can't be attached."
        : `A video must be uploaded as the video file itself (${SERVICE_FINAL_VIDEO_EXTENSIONS.map(
            (e) => `.${e}`
          ).join(' or ')}).`
    );
  const extension = fileExtension(file.fileName);
  if (isModelName(file.fileName)) {
    const format = MODEL_FORMATS[extension];
    if (!format?.(head) || (isZipStart(head) && !(await isTorchArchive(file))))
      throw notItsFormat('model', extension);
    return false;
  }
  const audio = AUDIO_FORMATS[extension];
  if (audio && !audio(head)) throw notItsFormat('audio', extension);
  if (kind === 'archive')
    throw new ZipRejectedError('Archives must be delivered as a .zip, not renamed.');
  if (kind === 'unscannable')
    throw new ZipRejectedError(
      'This image format cannot be delivered. Use PNG, JPEG, WebP or GIF.'
    );
  return kind === 'image';
}

// An inline preview of these types must strip or refuse embedded data: images.
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'yaml', 'yml', 'csv']);

type DocumentBytes = {
  /** Every byte, in order. */
  open: () => AsyncIterable<Buffer> | Promise<AsyncIterable<Buffer>>;
};

/**
 * A document has no content scan, so a Final or a zip entry named as one must be what its name says,
 * all of it: a text file is valid UTF-8 with no NUL byte anywhere. Anything else would be delivered
 * unscanned, so it is refused.
 */
async function isTheDocumentItsNamed(name: string, { open }: DocumentBytes) {
  if (!TEXT_EXTENSIONS.has(fileExtension(name))) return true;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of await open()) {
      if (chunk.includes(0)) return false;
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return false;
    throw error;
  }
  return true;
}

async function finalBytes(file: ClaimedFinal): Promise<DocumentBytes> {
  const source = s3ZipSource(getS3Client(), await getBucket(), file.s3Key, file.size);
  return { open: () => source.readRange(0, file.size) };
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
    await submitEntryImage(file.id, 0, original, file.uploaderId);
  } catch (error) {
    if (!(error instanceof PreviewRejectedError)) throw error;
    await failEntry(file.id, 0, 'This image could not be read.');
    throw new ZipRejectedError('This image could not be read.');
  }
}

const VIDEO_UNREADABLE =
  "This video could not be read, or carries extra tracks or data that can't be checked (subtitles, cover art, chapters, transparency, embedded metadata, a second video). Export it again as a plain MP4 or WebM with one video track, without transparency or metadata.";
/** Header, samples and probe may differ by about a frame; more is a file claiming one length and holding another. */
const VIDEO_LENGTH_TOLERANCE_SECONDS = 1;

/**
 * A video Final has a single entry: the video itself, scanned as a site upload is. The scan copy is
 * the exact version of the held object the buyer will be served, and that version's ETag is recorded
 * on the file, so a download can refuse bytes the scan did not see. A video longer than site uploads
 * allow is refused before its copy is scanned.
 */
async function unpackVideo(file: ClaimedFinal, probeVideo: typeof probeVideoDimensions) {
  if (file.size > constants.mediaUpload.maxVideoFileSize)
    throw new ZipRejectedError('That video is too large to deliver.');
  await dbWrite.$executeRaw`
    INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size")
    VALUES (${file.id}::int, ${file.dealId}::int, 0, ${file.fileName}::text, ${file.size}::int)
    ON CONFLICT ("fileId", "entryIndex") DO NOTHING`;
  const [entry] = await dbWrite.$queryRaw<EntryRow[]>`
    SELECT "id", "dealId", "path", "size", "imageId", "scanKey", "scanStatus"::text AS "scanStatus"
    FROM "ServiceDealFileEntry" WHERE "fileId" = ${file.id}::int AND "entryIndex" = 0`;
  if (!entry || entry.imageId || entry.scanStatus !== 'Pending') return;

  const object: GetObjectCommandOutput = await getS3Client().send(
    new GetObjectCommand({ Bucket: await getBucket(), Key: file.s3Key })
  );
  if (!object.Body || !object.ETag) throw new Error('Video read returned no body or ETag');
  // A view over the bytes read, not a copy: one video's size in memory, not two.
  const read = await object.Body.transformToByteArray();
  const original = Buffer.from(read.buffer, read.byteOffset, read.byteLength);
  if (sniffEntry(original.subarray(0, 16)) !== 'video')
    throw new ZipRejectedError(VIDEO_UNREADABLE);
  // The header's length is the writer's claim; the samples are what plays. Both are measured.
  const lengths = readVideoLengths(original);
  if (!lengths) throw new ZipRejectedError(VIDEO_UNREADABLE);

  const mimeType = fileExtension(file.fileName) === 'webm' ? 'video/webm' : 'video/mp4';
  let scanKey = entry.scanKey;
  if (!scanKey) {
    ({ key: scanKey } = await uploadImageBufferToStore(original, { contentType: mimeType }));
    await dbWrite.$executeRaw`
      UPDATE "ServiceDealFileEntry" SET "scanKey" = ${scanKey}::text WHERE "id" = ${entry.id}::int`;
  }
  const dropCopy = async () => {
    const store = await getImageUploadBackend();
    await deleteObject(store.bucket, scanKey!, store.s3).catch(() => null);
  };
  const probed = await probeVideo(scanKey);
  // No answer from the probe is retried; an answer with no length is a video the scan cannot be
  // shown to cover.
  if (!probed) throw new Error('Video probe returned nothing');
  if (!probed.duration) {
    await dropCopy();
    await failEntry(file.id, 0, VIDEO_UNREADABLE);
    throw new ZipRejectedError(VIDEO_UNREADABLE);
  }
  const all = [probed.duration, ...lengths];
  const refusal =
    Math.max(...all) > constants.mediaUpload.maxVideoDurationSeconds
      ? SERVICE_FINAL_VIDEO_TOO_LONG
      : Math.max(...all) - Math.min(...all) > VIDEO_LENGTH_TOLERANCE_SECONDS
      ? SERVICE_FINAL_VIDEO_LENGTH_UNCLEAR
      : undefined;
  if (refusal) {
    await dropCopy();
    await failEntry(file.id, 0, refusal);
    throw new ZipRejectedError(refusal);
  }
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile"
    SET "scannedEtag" = ${object.ETag}::text, "scannedVersionId" = ${object.VersionId ?? null}::text
    WHERE "id" = ${file.id}::int`;
  // A crash after the Image was made leaves it to be found.
  const imageId =
    (entry.scanKey ? await findScanCopyImageId(scanKey) : undefined) ??
    (
      await createScanImage(
        scanKey,
        { mimeType, width: probed.width, height: probed.height, data: original, type: 'video' },
        file.uploaderId
      )
    ).id;
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealFileEntry" SET "imageId" = ${imageId}::int WHERE "id" = ${entry.id}::int`;
}

/**
 * Step 1: unpack one Final that has not been. A problem with the file itself fails it with a
 * reason the seller can read; anything else (a dropped connection) leaves it to be retried.
 * Returns the number of files finished.
 */
export async function unpackFinals({
  shouldStop = () => false,
  probeVideo = probeVideoDimensions,
}: { shouldStop?: () => boolean; probeVideo?: typeof probeVideoDimensions } = {}) {
  const [file] = await claimFinal();
  if (!file) return 0;
  const began = Date.now();
  try {
    const extension = fileExtension(file.fileName);
    if (holdsPdfHeader(await readRawPrefix(file)))
      throw new ZipRejectedError(SERVICE_FINAL_PDF_REFUSAL);
    if (extension === 'zip') {
      if (!(await unpackZip(file, shouldStop))) {
        await release(file.id);
        return 0;
      }
    } else if (file.kind === 'Final' && isFinalVideoName(file.fileName)) {
      await unpackVideo(file, probeVideo);
    } else if (isImageName(file.fileName)) {
      await unpackImage(file);
    } else if (await isImageByContent(file)) {
      await unpackImage(file);
    } else if (!(await isTheDocumentItsNamed(file.fileName, await finalBytes(file)))) {
      throw notItsFormat('document', extension);
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
            OR i."nsfwLevel" NOT BETWEEN 1 AND ${NsfwLevel.XXX}::int)))`;
  // Only the rating is above the deal's level: the seller is told that, and nothing else.
  const overLevel = await dbWrite.$queryRaw<{ fileId: number | null }[]>`
    UPDATE "ServiceDealFileEntry" e
    SET "scanStatus" = 'Failed'::"ServiceDealFileScanStatus", "nsfwLevel" = i."nsfwLevel",
      "failReason" = ${SERVICE_FINAL_OVER_LEVEL_REASON}
    FROM "Image" i, "ServiceDeal" d
    WHERE i."id" = e."imageId" AND d."id" = e."dealId" AND ${waiting}
      AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"
      AND i."needsReview" IS NULL AND NOT i."poi" AND NOT i."minor"
      AND i."nsfwLevel" > ${MAX_LEVEL} AND i."nsfwLevel" <= ${NsfwLevel.XXX}::int
    RETURNING e."fileId"`;
  // The seller of a Final is told why; an Attachment's uploader keeps the plain reason.
  const overLevelFiles = overLevel.flatMap(({ fileId }) => (fileId ? [fileId] : []));
  if (overLevelFiles.length)
    await dbWrite.$executeRaw`
      UPDATE "ServiceDealFile" SET "failReason" = ${SERVICE_FINAL_OVER_LEVEL_REASON}
      WHERE "id" IN (${Prisma.join(overLevelFiles)}) AND "kind" = 'Final'::"ServiceDealFileKind"
        AND "failReason" IS NULL`;
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
  return { passed, rejected: rejected + overLevel.length, unchecked, timedOut };
}

const WAITING_FOR_MALWARE_SCAN = Prisma.sql`
  "kind"::text IN (${SCANNED_FILE_KINDS})
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

  const waiting = await dbWrite.$queryRaw<
    { id: number; workflowId: string; stale: boolean; scannedEtag: string | null }[]
  >`
    SELECT "id", "malwareScanWorkflowId" AS "workflowId", "scannedEtag",
      "malwareScanSubmittedAt" < now() - (${SERVICE_FINAL_SCAN_STALE_MS}::int * interval '1 millisecond') AS "stale"
    FROM "ServiceDealFile"
    WHERE ${WAITING_FOR_MALWARE_SCAN} AND "malwareScanWorkflowId" IS NOT NULL
    ORDER BY "id" LIMIT 50`;
  for (const { id, workflowId, stale, scannedEtag } of waiting) {
    if (shouldStop()) return counts;
    const reading = await getFinalScanReading(workflowId, {
      video: acceptedAsVideo({ scannedEtag }),
    }).catch((error) => {
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

/** Files `settleFinals` reads per query and pass. */
export const SETTLE_BATCH = 50;

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
        WHERE "kind"::text IN (${SCANNED_FILE_KINDS})
          AND "scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
          AND "malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus"
        ORDER BY "id" LIMIT ${SETTLE_BATCH}::int)
      RETURNING "id"`;
    if (skipped.length) logUnpack('skipped malware scans queued', { count: skipped.length });
  }

  const failing = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT f."id" FROM "ServiceDealFile" f
    WHERE f."kind"::text IN (${SCANNED_FILE_KINDS})
      AND f."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND (f."failReason" IS NOT NULL
        OR (f."unpackedAt" < now() - (${SERVICE_FINAL_SCAN_GIVE_UP_MS}::int * interval '1 millisecond')
          AND f."repackedAt" IS NULL)
        OR f."malwareScanStatus" = 'Failed'::"ServiceDealFileScanStatus"
        OR EXISTS (SELECT 1 FROM "ServiceDealFileEntry" e
          WHERE e."fileId" = f."id" AND e."scanStatus" = 'Failed'::"ServiceDealFileScanStatus"))
    ORDER BY f."id" LIMIT ${SETTLE_BATCH}::int`;
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
    WHERE f."kind"::text IN (${SCANNED_FILE_KINDS})
      AND f."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND f."unpackedAt" IS NOT NULL
      AND f."repackedAt" IS NOT NULL
      AND (f."malwareScanStatus" = 'Passed'::"ServiceDealFileScanStatus"
        OR (f."malwareScanStatus" = 'NotScanned'::"ServiceDealFileScanStatus" AND NOT ${malwareScanOn}
          AND f."kind"::text <> 'Attachment'))
      AND NOT EXISTS (SELECT 1 FROM "ServiceDealFileEntry" e
        WHERE e."fileId" = f."id" AND e."scanStatus" <> 'Passed'::"ServiceDealFileScanStatus")
    ORDER BY f."id" LIMIT ${SETTLE_BATCH}::int`;
  let passed = 0;
  for (const { id } of clear) {
    const result = await recordFinalScanResult({ fileId: id, verdict: 'Passed' });
    if (result.recorded) passed++;
  }
  return { finalsFailed: failed, finalsPassed: passed };
}

/** When `countDanglingScanCopies` last counted. Kept in memory: a restart only counts sooner. */
let danglingCountedAt = 0;

/**
 * Counts and logs entries pointing at a gone image, at most hourly. Each refuses and keeps its file
 * (`imageGone`). `settling` ones are our own delete within the settle window, which the next copy
 * run settles; `dangling` ones (unmarked, or marked past that window) are a backlog. Null when it did
 * not count this run.
 */
export async function countDanglingScanCopies({ now = Date.now() } = {}) {
  if (now - danglingCountedAt < 60 * 60_000) return null;
  danglingCountedAt = now;
  const [counts] = await dbWrite.$queryRaw<{ settling: number; dangling: number }[]>`
    SELECT count(*) FILTER (WHERE NOT ${entryImageGone(Prisma.sql`e`, {
      exceptSettling: true,
    })})::int AS settling,
      count(*) FILTER (WHERE ${entryImageGone(Prisma.sql`e`, { exceptSettling: true })})::int
        AS dangling
    FROM "ServiceDealFileEntry" e WHERE ${entryImageGone(Prisma.sql`e`)}`;
  logUnpack(
    'entries pointing at a gone image',
    { count: counts.dangling, total: counts.settling + counts.dangling },
    counts.dangling ? 'warning' : 'info'
  );
  return counts;
}

/** The last entry `deleteEntryScanCopies` tried. Kept in memory: a restart only starts it over. */
let copiesCursor = 0;

/**
 * Step 5: the copy of an image that passed has done its job. This step KEEPS the copy of an image
 * whose scan has not finished, or that was refused, even after its file was deleted: its Image row
 * is what the moderation tooling reads, and deleting it would take the evidence with it. Only
 * purgeRemovedFiles deletes such a copy, and only an over-level one, together with its file. A copy
 * whose file is gone is judged like any other (see `settleEntryScans`) and its row goes with it once
 * it passes. A delete that fails stays pointed at and is retried.
 */
export async function deleteEntryScanCopies({ limit = 50 } = {}) {
  // Each run starts after the last one's final row and wraps to the start, so copies kept for
  // their case are tried again but cannot fill every batch.
  const rows = await dbWrite.$queryRaw<{ id: number; imageId: number; fileId: number | null }[]>`
    SELECT e."id", e."imageId", e."fileId" FROM "ServiceDealFileEntry" e
    WHERE e."imageId" IS NOT NULL AND e."scanStatus" = 'Passed'::"ServiceDealFileScanStatus"
    ORDER BY e."id" <= ${copiesCursor}::int, e."id" LIMIT ${limit}::int`;
  if (!rows.length) return 0;
  copiesCursor = rows[rows.length - 1].id;
  const { deleteImages } = await import('~/server/services/image.service');
  let deleted = 0;
  for (const row of rows) {
    try {
      await markCopyDeletes([row.id]);
      const gone = await deleteImages([row.imageId], {
        updatePosts: false,
        actor: { system: 'creator-service-deal-unpack' },
        onDeleted: releaseEntryCopies([row.id]),
      });
      // A copy kept for its case stays pointed at, and so does one gone without our delete.
      await settleCopyDeletes([row.id]);
      if (gone.some(({ id }) => id === row.imageId)) deleted++;
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
