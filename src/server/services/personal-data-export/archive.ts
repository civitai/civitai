import { newS3Client } from '~/utils/s3-client-factory';
import { randomUUID } from 'crypto';
import stream, { Readable } from 'stream';
import archiver from 'archiver';
import type { S3Client } from '@aws-sdk/client-s3';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { env } from '~/env/server';
import { getGetUrlByKey } from '~/utils/s3-utils';
import type { ExportWriter } from './output';

/** How long a download link works. */
export const LINK_TTL_SECONDS = 48 * 60 * 60;
/**
 * How long after it is written an archive can still be fetched: the bucket hides it at 6 days (and
 * deletes it a day later), and a hidden object cannot be fetched. Change it with the bucket rule.
 */
export const BUCKET_TTL_SECONDS = 6 * 24 * 60 * 60;
/**
 * How long after the build Release stays open (4 days): a link is only handed out while the archive
 * will outlive it.
 */
export const RELEASE_WINDOW_SECONDS = BUCKET_TTL_SECONDS - LINK_TTL_SECONDS;

/** `queueSize * partSize` is the upload's in-flight buffer. */
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;

export type ExportBucket = { client: S3Client; Bucket: string };

/** The export bucket, or null when it is not configured. Its own bucket, never a prefix of another. */
export function getExportBucket(): ExportBucket | null {
  const { PERSONAL_DATA_EXPORT_ENDPOINT, PERSONAL_DATA_EXPORT_REGION } = env;
  const { PERSONAL_DATA_EXPORT_BUCKET, PERSONAL_DATA_EXPORT_KEY, PERSONAL_DATA_EXPORT_SECRET } =
    env;
  if (
    !PERSONAL_DATA_EXPORT_ENDPOINT ||
    !PERSONAL_DATA_EXPORT_REGION ||
    !PERSONAL_DATA_EXPORT_BUCKET ||
    !PERSONAL_DATA_EXPORT_KEY ||
    !PERSONAL_DATA_EXPORT_SECRET
  )
    return null;
  const client = newS3Client({
    credentials: {
      accessKeyId: PERSONAL_DATA_EXPORT_KEY,
      secretAccessKey: PERSONAL_DATA_EXPORT_SECRET,
    },
    region: PERSONAL_DATA_EXPORT_REGION,
    endpoint: PERSONAL_DATA_EXPORT_ENDPOINT,
  });
  return { client, Bucket: PERSONAL_DATA_EXPORT_BUCKET };
}

/** Every object of an export lives under its id; each attempt writes a fresh key. */
export function exportObjectKey(exportId: number, kind: 'archive' | 'notes') {
  if (!Number.isSafeInteger(exportId) || exportId <= 0) throw new Error('Bad export id');
  return `exports/${exportId}/${randomUUID()}${
    kind === 'archive' ? '.zip' : '-internal-notes.csv'
  }`;
}

/** A download link, signed against the bucket's own endpoint. */
export async function presignDownload(
  bucket: ExportBucket,
  key: string,
  filename: string
): Promise<{ url: string; expiresAt: Date }> {
  const { url } = await getGetUrlByKey(key, {
    s3: bucket.client,
    bucket: bucket.Bucket,
    expiresIn: LINK_TTL_SECONDS,
    fileName: filename,
  });
  return { url, expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000) };
}

export async function putSmallObject(
  bucket: ExportBucket,
  key: string,
  body: string,
  contentType: string
) {
  await bucket.client.send(
    new PutObjectCommand({ Bucket: bucket.Bucket, Key: key, Body: body, ContentType: contentType })
  );
}

/** Deletes objects, best effort: one that stays is removed by the bucket's own expiry. */
export async function deleteObjects(bucket: ExportBucket, keys: (string | null)[]) {
  for (const key of keys) {
    if (!key) continue;
    try {
      await bucket.client.send(new DeleteObjectCommand({ Bucket: bucket.Bucket, Key: key }));
    } catch {
      // The bucket expires it anyway.
    }
  }
}

/**
 * Builds a zip straight into the bucket: archiver -> PassThrough -> multipart Upload, with nothing
 * staged on disk. Entries are appended one at a time and each is awaited until archiver has written
 * it, so at most one source is open and backpressure from the upload reaches the source.
 *
 * Resolves only after `Upload.done()`: the caller marks the export built after this, never before.
 * On any failure the archive and the upload are both torn down and the error is rethrown.
 */
export async function streamArchiveToBucket(
  bucket: ExportBucket,
  key: string,
  build: (writer: ExportWriter) => Promise<void>
): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const sink = new stream.PassThrough();
  // `pipeline`, not `.pipe()`: a destroyed sink must error the archiver, or every pending append
  // waits forever (see `uploadStream` in csam.service-new.ts).
  stream.pipeline(archive, sink, () => undefined);

  const upload = new Upload({
    client: bucket.client,
    params: { Bucket: bucket.Bucket, Key: key, Body: sink, ContentType: 'application/zip' },
    partSize: PART_SIZE,
    queueSize: QUEUE_SIZE,
    leavePartsOnError: false,
  });
  // Started before anything is appended (nothing drains the sink otherwise), and observed at once
  // so a failed upload is a rejection here rather than an unhandled one.
  let uploadError: unknown;
  const uploaded = upload.done().then(
    () => undefined,
    (e: unknown) => {
      uploadError = e;
      sink.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  );

  let archiveError: unknown;
  archive.on('error', (e) => (archiveError ??= e));
  archive.on('warning', (e) => (archiveError ??= e));

  const writer: ExportWriter = {
    addFile(name, content) {
      return new Promise<void>((resolve, reject) => {
        if (archiveError) return reject(archiveError);
        const onEntry = (entry: { name: string }) => {
          if (entry.name !== name) return;
          cleanup();
          resolve();
        };
        const onError = (e: unknown) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          archive.off('entry', onEntry);
          archive.off('error', onError);
          archive.off('warning', onError);
        };
        archive.on('entry', onEntry);
        archive.on('error', onError);
        archive.on('warning', onError);
        const source =
          typeof content === 'string'
            ? Readable.from([Buffer.from(content)], { objectMode: false })
            : Readable.from(toBuffers(content), { objectMode: false });
        // 🔴 archiver does not watch its sources for errors: a source that throws leaves the entry
        // unfinished and every await on it parked forever. The error is caught here instead, and
        // the build's catch below tears the archive and the upload down.
        source.once('error', onError);
        archive.append(source, { name });
      });
    },
  };

  try {
    await build(writer);
    if (archiveError) throw archiveError;
    await archive.finalize();
    await uploaded;
    if (uploadError) throw uploadError;
    if (archiveError) throw archiveError;
  } catch (e) {
    archive.abort();
    sink.destroy();
    await upload.abort().catch(() => undefined);
    await uploaded;
    // An upload that failed first is the cause; otherwise the upload error is our own abort.
    throw e === archiveError && uploadError ? uploadError : e;
  }
}

async function* toBuffers(content: AsyncIterable<string>) {
  for await (const chunk of content) yield Buffer.from(chunk);
}
