// Low-level S3 / R2 / B2 object client for the storage service. Owns the S3Client construction plus the
// primitive object ops (delete / presign / head). Config is explicit (resolved per backend in
// backends.ts from the app's env) — no env coupling here. This is the service-side engine the HTTP
// routes call; the shared pure URL helpers come from @civitai/storage.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type GetObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { parseKey, type MultipartPart } from '@civitai/storage';

export type S3BackendConfig = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket?: string;
  region?: string;
  forcePathStyle?: boolean;
};

/**
 * The timeouts every client this service builds gets. The SDK sets no connect timeout and no socket
 * timeout, so a store that accepts a connection and never answers holds the request (and the caller's own
 * retries on top) indefinitely.
 * - `connectionTimeoutMs` covers waiting for a free socket in the pool PLUS the TCP/TLS connect, so the
 *   pool is sized past smithy's default of 50 (`maxSockets`); a burst would otherwise fail at this timeout
 *   instead of queueing.
 * - `requestTimeoutMs` is socket INACTIVITY, not total duration, so a transfer that keeps moving bytes is
 *   never cut off.
 * Attempts stay at the SDK default (3). Same numbers as the main app's `src/utils/s3-client-factory.ts`,
 * and the same off-switch: `S3_CLIENT_TIMEOUTS=off` (or `0` / `false`, any case).
 */
export const S3_CLIENT_BOUNDS = {
  connectionTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxSockets: 256,
};
export type S3ClientBounds = typeof S3_CLIENT_BOUNDS;

export type S3ClientOptions = {
  uploadExpiration?: number;
  downloadExpiration?: number;
  /** Overrides {@link S3_CLIENT_BOUNDS} (tests). */
  bounds?: Partial<S3ClientBounds>;
  /** Overrides the SDK's attempt count (tests). */
  maxAttempts?: number;
};

/** The SDK client for one backend, with {@link S3_CLIENT_BOUNDS} unless `bounds` overrides them. */
export function buildS3Client(
  config: S3BackendConfig,
  boundsOverride: Partial<S3ClientBounds> = {},
  maxAttempts?: number
): S3Client {
  const bounds = { ...S3_CLIENT_BOUNDS, ...boundsOverride };
  const timeoutsOff = ['off', '0', 'false'].includes(
    (process.env.S3_CLIENT_TIMEOUTS ?? '').trim().toLowerCase()
  );
  return new S3Client({
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    endpoint: config.endpoint,
    // R2/custom S3-compatible endpoints ignore region, but the SDK requires a value.
    region: config.region ?? 'us-east-1',
    ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(maxAttempts ? { maxAttempts } : {}),
    ...(timeoutsOff
      ? {}
      : {
          requestHandler: {
            connectionTimeout: bounds.connectionTimeoutMs,
            requestTimeout: bounds.requestTimeoutMs,
            httpAgent: { maxSockets: bounds.maxSockets },
            httpsAgent: { maxSockets: bounds.maxSockets },
          },
        }),
  });
}

const DEFAULT_UPLOAD_EXPIRATION = 60 * 60 * 12; // 12h
const DEFAULT_DOWNLOAD_EXPIRATION = 60 * 60 * 24; // 24h
const DEFAULT_MULTIPART_CHUNK_SIZE = 25 * 1024 * 1024; // 25MB
const DELETE_OBJECTS_LIMIT = 1000; // S3/R2 DeleteObjects hard cap per call

type GetUrlOptions = { bucket?: string; expiresIn?: number; fileName?: string };

export type HeadResult = {
  exists: boolean;
  size?: number;
  mimeType?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
};

export type S3Backend = ReturnType<typeof createS3Client>;

export function createS3Client(config: S3BackendConfig, options: S3ClientOptions = {}) {
  const uploadExpiration = options.uploadExpiration ?? DEFAULT_UPLOAD_EXPIRATION;
  const downloadExpiration = options.downloadExpiration ?? DEFAULT_DOWNLOAD_EXPIRATION;

  const client = buildS3Client(config, options.bounds, options.maxAttempts);

  const endpointHost = new URL(config.endpoint).hostname;

  function requireBucket(bucket?: string): string {
    const b = bucket ?? config.bucket;
    if (!b) throw new Error('[storage] no bucket configured for this backend (pass an override)');
    return b;
  }

  function deleteObject(key: string, bucket?: string) {
    return client.send(new DeleteObjectCommand({ Bucket: requireBucket(bucket), Key: key }));
  }

  // DeleteObjects caps at 1000 keys/call — chunk so callers can pass any count.
  function deleteManyObjects(keys: string[], bucket?: string) {
    const b = requireBucket(bucket);
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += DELETE_OBJECTS_LIMIT) {
      chunks.push(keys.slice(i, i + DELETE_OBJECTS_LIMIT));
    }
    return Promise.all(
      chunks.map((chunk) =>
        client.send(
          new DeleteObjectsCommand({
            Bucket: b,
            Delete: { Objects: chunk.map((Key) => ({ Key })) },
          })
        )
      )
    );
  }

  async function getPutUrl(key: string, opts?: { bucket?: string; expiresIn?: number }) {
    const bucket = requireBucket(opts?.bucket);
    const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: opts?.expiresIn ?? uploadExpiration,
    });
    return { url, bucket, key };
  }

  async function getMultipartPutUrl(
    key: string,
    size: number,
    opts?: { bucket?: string; mimeType?: string; chunkSize?: number; expiresIn?: number }
  ) {
    const bucket = requireBucket(opts?.bucket);
    const chunkSize = opts?.chunkSize ?? DEFAULT_MULTIPART_CHUNK_SIZE;
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: opts?.mimeType })
    );
    const urls = await Promise.all(
      Array.from({ length: Math.ceil(size / chunkSize) }, (_, i) =>
        getSignedUrl(
          client,
          new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: i + 1 }),
          { expiresIn: opts?.expiresIn ?? uploadExpiration }
        ).then((url) => ({ url, partNumber: i + 1 }))
      )
    );
    return { urls, bucket, key, uploadId: UploadId as string, chunkSize };
  }

  // Streaming multipart: create the upload, then presign parts on demand (size not known up front).
  async function createMultipartUpload(key: string, opts?: { bucket?: string; mimeType?: string }) {
    const bucket = requireBucket(opts?.bucket);
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: opts?.mimeType })
    );
    return { uploadId: UploadId as string, bucket, key };
  }

  async function presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    opts?: { bucket?: string; expiresIn?: number }
  ) {
    const bucket = requireBucket(opts?.bucket);
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: opts?.expiresIn ?? uploadExpiration }
    );
    return { url, partNumber };
  }

  function completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
    bucket?: string
  ) {
    return client.send(
      new CompleteMultipartUploadCommand({
        Bucket: requireBucket(bucket),
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  }

  function abortMultipartUpload(key: string, uploadId: string, bucket?: string) {
    return client.send(
      new AbortMultipartUploadCommand({
        Bucket: requireBucket(bucket),
        Key: key,
        UploadId: uploadId,
      })
    );
  }

  async function getGetUrl(fileUrl: string, opts: GetUrlOptions = {}) {
    const { key, bucket: parsedBucket } = parseKey(fileUrl, { s3Host: endpointHost });
    const bucket = opts.bucket ?? parsedBucket ?? requireBucket();
    const command: GetObjectCommandInput = { Bucket: bucket, Key: key };
    if (opts.fileName)
      command.ResponseContentDisposition = `attachment; filename="${opts.fileName}"`;
    const url = await getSignedUrl(client, new GetObjectCommand(command), {
      expiresIn: opts.expiresIn ?? downloadExpiration,
    });
    return { url, bucket, key };
  }

  async function getGetUrlByKey(key: string, opts: GetUrlOptions = {}) {
    const bucket = requireBucket(opts.bucket);
    const command: GetObjectCommandInput = { Bucket: bucket, Key: key };
    if (opts.fileName)
      command.ResponseContentDisposition = `attachment; filename="${opts.fileName}"`;
    const url = await getSignedUrl(client, new GetObjectCommand(command), {
      expiresIn: opts.expiresIn ?? downloadExpiration,
    });
    return { url, bucket, key };
  }

  // HeadObject → metadata, mapping a not-found (404 / NoSuchKey / NotFound) to `{ exists: false }`.
  // Other errors rethrow so a real backend failure surfaces as a 5xx, not a false negative.
  async function headObject(key: string, bucket?: string): Promise<HeadResult> {
    const { key: parsedKey, bucket: parsedBucket } = parseKey(key, { s3Host: endpointHost });
    try {
      const data = await client.send(
        new HeadObjectCommand({ Key: parsedKey, Bucket: bucket ?? parsedBucket ?? requireBucket() })
      );
      return {
        exists: true,
        size: data.ContentLength,
        mimeType: data.ContentType,
        lastModified: data.LastModified,
        metadata: data.Metadata,
      };
    } catch (error) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err?.name === 'NotFound' ||
        err?.name === 'NoSuchKey' ||
        err?.$metadata?.httpStatusCode === 404
      ) {
        return { exists: false };
      }
      throw error;
    }
  }

  return {
    deleteObject,
    deleteManyObjects,
    getPutUrl,
    getMultipartPutUrl,
    createMultipartUpload,
    presignUploadPart,
    completeMultipartUpload,
    abortMultipartUpload,
    getGetUrl,
    getGetUrlByKey,
    headObject,
  };
}
