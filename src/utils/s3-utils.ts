import type { GetObjectCommandInput } from '@aws-sdk/client-s3';
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
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server';
import { isFlipt, FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

const missingEnvs = (): string[] => {
  const keys = [];
  if (!env.S3_UPLOAD_KEY) keys.push('S3_UPLOAD_KEY');
  if (!env.S3_UPLOAD_SECRET) keys.push('S3_UPLOAD_SECRET');
  if (!env.S3_UPLOAD_ENDPOINT) keys.push('S3_UPLOAD_ENDPOINT');
  if (!env.S3_UPLOAD_BUCKET) keys.push('S3_UPLOAD_BUCKET');
  return keys;
};

export type UploadBackend = 'default' | 'b2';

export function getB2S3Client() {
  if (!env.S3_UPLOAD_B2_ACCESS_KEY || !env.S3_UPLOAD_B2_SECRET_KEY || !env.S3_UPLOAD_B2_ENDPOINT) {
    throw new Error('B2 upload credentials not configured');
  }
  return new S3Client({
    credentials: {
      accessKeyId: env.S3_UPLOAD_B2_ACCESS_KEY,
      secretAccessKey: env.S3_UPLOAD_B2_SECRET_KEY,
    },
    region: env.S3_UPLOAD_B2_REGION ?? 'us-west-004',
    endpoint: env.S3_UPLOAD_B2_ENDPOINT,
    forcePathStyle: true,
  });
}

export function getUploadS3Client(backend: UploadBackend = 'default') {
  if (backend === 'b2') return getB2S3Client();
  return getS3Client();
}

export function getUploadBucket(backend: UploadBackend = 'default') {
  if (backend === 'b2') return env.S3_UPLOAD_B2_BUCKET ?? 'civitai-modelfiles';
  return env.S3_UPLOAD_BUCKET;
}

export type ImageUploadBackend = 'cloudflare' | 'backblaze';

let _b2ImageS3Client: S3Client | null = null;
export function getB2ImageS3Client(): S3Client {
  if (!env.S3_IMAGE_B2_ACCESS_KEY || !env.S3_IMAGE_B2_SECRET_KEY || !env.S3_IMAGE_B2_ENDPOINT) {
    throw new Error('B2 image upload credentials not configured');
  }
  if (!_b2ImageS3Client) {
    _b2ImageS3Client = new S3Client({
      credentials: {
        accessKeyId: env.S3_IMAGE_B2_ACCESS_KEY,
        secretAccessKey: env.S3_IMAGE_B2_SECRET_KEY,
      },
      region: env.S3_IMAGE_B2_REGION ?? 'us-west-004',
      endpoint: env.S3_IMAGE_B2_ENDPOINT,
      forcePathStyle: true,
    });
  }
  return _b2ImageS3Client;
}

export async function getImageUploadBackend(userId?: number): Promise<{
  s3: S3Client;
  bucket: string;
  backend: ImageUploadBackend;
}> {
  // Server-side paths (orchestrator, comics) pass no userId and default to DO Spaces.
  // This is intentional for Phase 1 — migrate user-facing uploads first, then flip server-side.
  const useB2 =
    env.S3_IMAGE_B2_ACCESS_KEY &&
    (userId ? await isFlipt(FLIPT_FEATURE_FLAGS.B2_IMAGE_UPLOAD, String(userId)) : false);

  if (useB2) {
    return {
      s3: getB2ImageS3Client(),
      bucket: env.S3_IMAGE_B2_BUCKET ?? 'civitai-media-uploads',
      backend: 'backblaze',
    };
  }

  return {
    s3: getS3Client('image'),
    bucket: env.S3_IMAGE_UPLOAD_BUCKET,
    backend: 'cloudflare',
  };
}

type S3Clients = 'model' | 'image';
export function getS3Client(destination: S3Clients = 'model') {
  const missing = missingEnvs();
  if (missing.length > 0) throw new Error(`Next S3 Upload: Missing ENVs ${missing.join(', ')}`);

  if (destination === 'image' && env.S3_IMAGE_UPLOAD_KEY && env.S3_IMAGE_UPLOAD_SECRET) {
    return new S3Client({
      credentials: {
        accessKeyId: env.S3_IMAGE_UPLOAD_KEY,
        secretAccessKey: env.S3_IMAGE_UPLOAD_SECRET,
      },
      region: env.S3_IMAGE_UPLOAD_REGION,
      endpoint: env.S3_IMAGE_UPLOAD_ENDPOINT,
      forcePathStyle: env.S3_IMAGE_FORCE_PATH_STYLE,
    });
  }

  return new S3Client({
    credentials: {
      accessKeyId: env.S3_UPLOAD_KEY,
      secretAccessKey: env.S3_UPLOAD_SECRET,
    },
    region: env.S3_UPLOAD_REGION,
    endpoint: env.S3_UPLOAD_ENDPOINT,
  });
}

export async function getBucket() {
  return env.S3_UPLOAD_BUCKET;
}

export async function getPutUrl(key: string, s3: S3Client | null = null) {
  const bucket = await getBucket();
  return getCustomPutUrl(bucket, key, s3);
}

export async function getCustomPutUrl(bucket: string, key: string, s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: UPLOAD_EXPIRATION,
  });
  return { url, bucket, key };
}

export function deleteObject(bucket: string, key: string, s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();
  return s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

// https://docs.aws.amazon.com/AmazonS3/latest/userguide/example_s3_DeleteObjects_section.html
export function deleteManyObjects(bucket: string, keys: string[], s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();
  return s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keys.map((key) => ({ Key: key })),
      },
    })
  );
}

/**
 * Delete the S3 object referenced by a ModelFile URL.
 * Determines the correct backend (R2 or B2) and extracts the S3 key from the URL.
 * Best-effort: callers should catch errors and log rather than blocking.
 */
export async function deleteModelFileObject(url: string) {
  if (!url) return;

  const isB2 = url.includes('backblazeb2.com');
  const key = extractKeyFromModelFileUrl(url);
  if (!key) return;

  const s3Client = isB2 ? getB2S3Client() : getS3Client();
  const bucket = isB2
    ? env.S3_UPLOAD_B2_BUCKET ?? 'civitai-modelfiles'
    : env.S3_UPLOAD_BUCKET;

  await deleteObject(bucket, key, s3Client);
}

/**
 * Batch-delete S3 objects for multiple ModelFile URLs.
 * Groups by backend (R2 vs B2) and issues one batch delete per backend.
 */
export async function deleteModelFileObjects(urls: string[]) {
  const r2Keys: string[] = [];
  const b2Keys: string[] = [];

  for (const url of urls) {
    if (!url) continue;
    const key = extractKeyFromModelFileUrl(url);
    if (!key) continue;

    if (url.includes('backblazeb2.com')) {
      b2Keys.push(key);
    } else {
      r2Keys.push(key);
    }
  }

  const promises: Promise<unknown>[] = [];

  if (r2Keys.length > 0) {
    promises.push(deleteManyObjects(env.S3_UPLOAD_BUCKET, r2Keys, getS3Client()));
  }
  if (b2Keys.length > 0) {
    const b2Bucket = env.S3_UPLOAD_B2_BUCKET ?? 'civitai-modelfiles';
    promises.push(deleteManyObjects(b2Bucket, b2Keys, getB2S3Client()));
  }

  await Promise.all(promises);
}

function extractKeyFromModelFileUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname.replace(/^\//, '');

    // Strip known bucket prefixes for path-style URLs
    const bucketPrefixes = [
      'civitai-delivery-worker-prod',
      'civitai-prod-settled',
      'civitai-modelfiles',
    ];
    for (const prefix of bucketPrefixes) {
      if (path.startsWith(prefix + '/')) {
        path = path.slice(prefix.length + 1);
        break;
      }
    }

    return path || undefined;
  } catch {
    return undefined;
  }
}

const DOWNLOAD_EXPIRATION = 60 * 60 * 24; // 24 hours
const UPLOAD_EXPIRATION = 60 * 60 * 12; // 12 hours
const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
export async function getMultipartPutUrl(
  key: string,
  size: number,
  s3: S3Client | null = null,
  bucket: string | null = null,
  mimeType?: string,
  chunkSize: number = FILE_CHUNK_SIZE
) {
  if (!s3) s3 = getS3Client();

  if (!bucket) bucket = await getBucket();
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: mimeType })
  );

  const promises = [];
  for (let i = 0; i < Math.ceil(size / chunkSize); i++) {
    promises.push(
      getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: i + 1 }),
        { expiresIn: UPLOAD_EXPIRATION }
      ).then((url) => ({ url, partNumber: i + 1 }))
    );
  }
  const urls = await Promise.all(promises);

  return { urls, bucket, key, uploadId: UploadId };
}

interface MultipartUploadPart {
  ETag: string;
  PartNumber: number;
}
export function completeMultipartUpload(
  bucket: string,
  key: string,
  uploadId: string,
  parts: MultipartUploadPart[],
  s3: S3Client | null = null
) {
  if (!s3) s3 = getS3Client();
  return s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

export async function abortMultipartUpload(
  bucket: string,
  key: string,
  uploadId: string,
  s3: S3Client | null = null
) {
  if (!s3) s3 = getS3Client();
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    })
  );
}

type GetObjectOptions = {
  s3?: S3Client | null;
  expiresIn?: number;
  fileName?: string;
  bucket?: string;
};

const s3Host = new URL(env.S3_UPLOAD_ENDPOINT).host;
const b2Host = env.S3_UPLOAD_B2_ENDPOINT ? new URL(env.S3_UPLOAD_B2_ENDPOINT).host : null;

export function parseKey(fileUrl: string) {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return { key: fileUrl };
  }

  const bucketInPath = url.hostname === s3Host || (b2Host !== null && url.hostname === b2Host);
  if (bucketInPath) {
    const pathParts = url.pathname.split('/');
    return {
      key: pathParts.slice(2).join('/'),
      bucket: pathParts[1],
    };
  }

  return {
    key: url.pathname.split('/').slice(1).join('/'),
    bucket: url.hostname.replace('.' + s3Host, ''),
  };
}

export function isB2Url(url: string): boolean {
  if (!b2Host) return false;
  try {
    return new URL(url).hostname === b2Host;
  } catch {
    return false;
  }
}

/**
 * Extract `{ bucket, key }` from a Backblaze B2 URL. Primary check is the
 * `*.backblazeb2.com` hostname pattern, which works without any env config
 * (important for admin scripts running in pods that don't set
 * `S3_UPLOAD_B2_ENDPOINT`). If the primary check fails, we fall back to
 * matching against the configured endpoint so custom proxies / non-public
 * endpoints still parse correctly when the env IS set.
 *
 * Accepts path-style (`https://s3.<region>.backblazeb2.com/<bucket>/<key>`)
 * and virtual-host style (`https://<bucket>.s3.<region>.backblazeb2.com/<key>`).
 * Returns `null` if neither check recognizes the URL.
 */
export function parseB2Url(rawUrl: string): { bucket: string; key: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const matchesPublicPattern = url.hostname.endsWith('.backblazeb2.com');
  const matchesConfiguredHost = b2Host !== null && url.hostname === b2Host;
  if (!matchesPublicPattern && !matchesConfiguredHost) return null;

  // Path-style endpoint → bucket is the first path segment.
  // We treat any `s3.*` hostname as path-style, and also whatever shape the
  // configured endpoint advertises (exact hostname match).
  const isPathStyle = url.hostname.startsWith('s3.') || matchesConfiguredHost;
  if (isPathStyle) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { bucket: parts[0], key: parts.slice(1).join('/') };
  }

  // Virtual-host style → first hostname label is the bucket.
  const dotIdx = url.hostname.indexOf('.');
  if (dotIdx <= 0) return null;
  const bucket = url.hostname.slice(0, dotIdx);
  const key = url.pathname.replace(/^\/+/, '');
  if (!key) return null;
  return { bucket, key };
}

export async function getGetUrl(
  s3Url: string,
  { s3, expiresIn = DOWNLOAD_EXPIRATION, fileName, bucket }: GetObjectOptions = {}
) {
  if (!s3) s3 = getS3Client();

  const { key: parsedKey, bucket: parsedBucket } = parseKey(s3Url);
  if (!bucket) bucket = parsedBucket ?? env.S3_UPLOAD_BUCKET;
  const command: GetObjectCommandInput = {
    Bucket: bucket,
    Key: parsedKey,
  };
  if (fileName) command.ResponseContentDisposition = `attachment; filename="${fileName}"`;

  const url = await getSignedUrl(s3, new GetObjectCommand(command), { expiresIn });
  return { url, bucket, key: parsedKey };
}

export async function getGetUrlByKey(
  key: string,
  { s3, expiresIn = DOWNLOAD_EXPIRATION, fileName, bucket }: GetObjectOptions = {}
) {
  if (!s3) s3 = getS3Client();

  if (!bucket) bucket = env.S3_UPLOAD_BUCKET;
  const command: GetObjectCommandInput = {
    Bucket: bucket,
    Key: key,
  };
  if (fileName) command.ResponseContentDisposition = `attachment; filename="${fileName}"`;

  const url = await getSignedUrl(s3, new GetObjectCommand(command), { expiresIn });
  return { url, bucket, key };
}

export async function checkFileExists(key: string, s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();

  try {
    const { key: parsedKey, bucket: parsedBucket } = parseKey(key);
    await s3.send(
      new HeadObjectCommand({
        Key: parsedKey,
        Bucket: parsedBucket ?? env.S3_UPLOAD_BUCKET,
      })
    );
  } catch {
    return false;
  }

  return true;
}

export async function getFileMetadata(
  key: string,
  { bucket, s3 }: { bucket?: string; s3?: S3Client } = {}
) {
  s3 ??= getS3Client();
  bucket ??= env.S3_UPLOAD_BUCKET;

  const { key: parsedKey, bucket: parsedBucket } = parseKey(key);
  const data = await s3.send(
    new HeadObjectCommand({
      Key: parsedKey,
      Bucket: parsedBucket ?? bucket,
    })
  );

  return {
    metadata: data.Metadata,
    size: data.ContentLength,
    mimeType: data.ContentType,
    lastModified: data.LastModified,
  };
}

export const serverUploadImage = async ({
  file,
  bucket,
  key,
}: {
  file: File | Blob;
  bucket: string;
  key: string;
}) => {
  const s3Client = getS3Client('image');
  return new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: file,
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false,
  });
};
