import { Upload } from '@aws-sdk/lib-storage';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import { finished } from 'stream/promises';
import * as yazl from 'yazl';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  handOffToScan,
  refuseFinal,
  retryLater,
} from '~/server/services/creator-service-deal-unpack.service';
import {
  deliveryName,
  openEntryStream,
  openZip,
  readEntry,
  s3ZipSource,
  ZipRejectedError,
  type OpenedZip,
} from '~/server/utils/service-deal-zip';
import {
  SERVICE_FINAL_MAX_BYTES,
  SERVICE_UNPACK_STALE_MS,
} from '~/shared/constants/creator-services.constants';
import { deleteObject, getBucket, getS3Client, headObject } from '~/utils/s3-utils';

/**
 * Builds the archive a buyer downloads: each checked entry of an unpacked zip Final is copied into
 * a new archive the server writes, which is read back before the file is ready for its malware scan.
 */

const DELIVERY_KEY_ROOT = 'service-deals/delivered';
/** Fixed, so the built archive is reproducible. */
const ENTRY_MTIME = new Date(Date.UTC(2020, 5, 15, 12));
const ENTRY_MODE = 0o100644;

const logRepack = (message: string, fields: Record<string, unknown>, type = 'info') =>
  logToAxiom({ name: 'creator-service-repack', type, message, ...fields }).catch(() => null);

type ClaimedZip = { id: number; dealId: number; round: number; s3Key: string; size: number };

/** Takes the one unpacked zip Final that has no delivery archive yet and that no run holds. */
function claimZip() {
  return dbWrite.$queryRaw<ClaimedZip[]>`
    UPDATE "ServiceDealFile" f SET "processingAt" = now()
    WHERE f."id" IN (
      SELECT p."id" FROM "ServiceDealFile" p
      WHERE p."kind" = 'Final'::"ServiceDealFileKind"
        AND p."status" = 'Ready'::"ServiceDealFileStatus"
        AND p."scanStatus" = 'Pending'::"ServiceDealFileScanStatus"
        AND p."unpackedAt" IS NOT NULL AND p."repackedAt" IS NULL AND p."failReason" IS NULL
        AND lower(p."fileName") LIKE '%.zip'
        AND (p."processingAt" IS NULL
          OR p."processingAt" < now() - (${SERVICE_UNPACK_STALE_MS}::int * interval '1 millisecond'))
      ORDER BY p."id" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING f."id", f."dealId", f."round", f."s3Key", f."size"`;
}

const release = (fileId: number) =>
  dbWrite.$executeRaw`UPDATE "ServiceDealFile" SET "processingAt" = NULL WHERE "id" = ${fileId}::int`;

class Stopped extends Error {}

/** Reads every entry once, so the same checks as the unpack step stand between the original and the copy. */
async function judge({ zipfile, entries }: OpenedZip, shouldStop: () => boolean) {
  const budget = { used: 0 };
  for (const entry of entries) {
    if (shouldStop()) throw new Stopped();
    await readEntry(zipfile, entry, budget, () => false);
  }
}

/** The names the new archive will carry. Two that differ only by case would be one file on a buyer's disk. */
function namesFor({ entries }: OpenedZip) {
  const names = entries.map((entry) => deliveryName(entry.path));
  const seen = new Set<string>();
  for (const name of names) {
    const folded = name.toLowerCase();
    if (seen.has(folded))
      throw new ZipRejectedError('The archive has two files with the same name.');
    seen.add(folded);
  }
  return names;
}

/** Streams the checked entries into a new archive in the bucket. Returns the bytes copied. */
async function build(
  opened: OpenedZip,
  names: string[],
  bucket: string,
  key: string,
  shouldStop: () => boolean
) {
  const out = new yazl.ZipFile();
  const written = out.outputStream as unknown as Readable;
  const upload = new Upload({
    client: getS3Client(),
    params: { Bucket: bucket, Key: key, Body: written, ContentType: 'application/zip' },
    queueSize: 1,
  });
  const uploaded = upload.done();
  // A failed upload stops reading the archive as it is written, so the copy below would wait for
  // ever: its failure is raced against every entry. (It never settles on success.)
  const uploadFailed = uploaded.then(() => new Promise<never>(() => undefined));
  uploadFailed.catch(() => null);
  uploaded.catch(() => null);
  out.on('error', (error) => written.destroy(error));

  const budget = { used: 0 };
  try {
    for (const [index, entry] of opened.entries.entries()) {
      if (shouldStop()) throw new Stopped();
      const stream = await openEntryStream(opened.zipfile, entry, budget);
      const consumed = finished(stream);
      out.addReadStream(stream, names[index], {
        mtime: ENTRY_MTIME,
        mode: ENTRY_MODE,
        compress: true,
      });
      await Promise.race([consumed, uploadFailed]);
    }
    out.end();
    await uploaded;
  } catch (error) {
    written.destroy();
    await upload.abort().catch(() => null);
    throw error;
  }
  return budget.used;
}

/**
 * Reads the new archive back with the same reader. It must hold exactly the files that were meant
 * to go into it, under exactly those names, and every one must pass the same checks.
 */
async function verify(bucket: string, key: string, names: string[], copiedBytes: number) {
  const head = await headObject(bucket, key);
  if (head.status !== 'present' || head.size === null)
    throw new Error('The delivery archive could not be read back.');
  if (head.size > SERVICE_FINAL_MAX_BYTES)
    throw new ZipRejectedError('The archive is too large to deliver.');
  // Our own compression may be better than the seller's, so the ratio is not asked of it again.
  const built = await openZip(s3ZipSource(getS3Client(), bucket, key, head.size), {
    checkRatio: false,
  });
  try {
    const found = built.entries.map((entry) => entry.path);
    const sizes = built.entries.reduce((sum, entry) => sum + entry.size, 0);
    if (found.length !== names.length || found.some((name, i) => name !== names[i]))
      throw new Error('The delivery archive does not hold the files it was built from.');
    if (sizes !== copiedBytes)
      throw new Error('The delivery archive differs in size from its sources.');
  } finally {
    built.zipfile.close();
  }
  return head.size;
}

/**
 * Builds the delivery archive for one unpacked zip Final. A problem with the archive itself fails
 * the file with a reason the seller can read; anything else (a dropped connection) is tried again
 * later and does not hold up the files behind it. Returns the number of files finished.
 */
export async function repackFinals({
  shouldStop = () => false,
}: { shouldStop?: () => boolean } = {}) {
  const [file] = await claimZip();
  if (!file) return 0;
  const began = Date.now();
  const bucket = await getBucket();
  const key = `${DELIVERY_KEY_ROOT}/${file.dealId}/${file.round}/${randomUUID()}`;
  let opened: OpenedZip | null = null;
  let written = false;
  try {
    opened = await openZip(s3ZipSource(getS3Client(), bucket, file.s3Key, file.size));
    await judge(opened, shouldStop);
    const names = namesFor(opened);
    written = true;
    const copied = await build(opened, names, bucket, key, shouldStop);
    const size = await verify(bucket, key, names, copied);

    const stored = await dbWrite.$executeRaw`
      UPDATE "ServiceDealFile"
      SET "deliveryKey" = ${key}::text, "deliverySize" = ${size}::int, "repackedAt" = now(),
        "processingAt" = NULL
      WHERE "id" = ${file.id}::int AND "repackedAt" IS NULL
        AND "scanStatus" = 'Pending'::"ServiceDealFileScanStatus" AND "failReason" IS NULL`;
    if (stored === 0) {
      await deleteObject(bucket, key).catch(() => null);
      return 0;
    }
    // The archive is the file's from here on. A hand-off that fails is logged, not undone.
    await handOffToScan(file.id).catch((error) =>
      logRepack(
        'scan hand-off failed',
        { fileId: file.id, error: (error as Error)?.message },
        'error'
      )
    );
    logRepack('delivery archive built', { fileId: file.id, bytes: size, ms: Date.now() - began });
    return 1;
  } catch (error) {
    if (written) await deleteObject(bucket, key).catch(() => null);
    if (error instanceof Stopped) {
      await release(file.id);
      return 0;
    }
    if (error instanceof ZipRejectedError) {
      await refuseFinal(file.id, error.message);
      logRepack('final refused', { fileId: file.id, ms: Date.now() - began });
      return 1;
    }
    logRepack(
      'repack failed; it will be retried',
      { fileId: file.id, error: (error as Error)?.message },
      'error'
    );
    await retryLater(file.id);
    return 0;
  } finally {
    opened?.zipfile.close();
  }
}
