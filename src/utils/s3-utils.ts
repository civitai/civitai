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
import { logToAxiom } from '~/server/logging/client';

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
 * Allowlist of civitai-owned buckets that the cleanup helpers are permitted
 * to delete from. Defense-in-depth: `ModelFile.url` is user-supplied and the
 * schema only validates `z.url()`, so a malicious user could otherwise point
 * `url` at an arbitrary R2/B2 bucket reachable by our credentials and trick
 * the cleanup path into deleting it on next update/delete.
 *
 * Composed from:
 *   1. Configured-bucket env vars (filtered to defined values).
 *   2. Hardcoded legacy R2 bucket names that hold existing ModelFile rows but
 *      are no longer referenced by any env var (historical writes).
 */
const MODEL_FILE_BUCKET_ALLOWLIST: ReadonlySet<string> = new Set(
  [
    env.S3_UPLOAD_BUCKET,
    env.S3_UPLOAD_B2_BUCKET,
    env.S3_VAULT_BUCKET,
    // Default fallback used by getUploadBucket when S3_UPLOAD_B2_BUCKET is unset.
    'civitai-modelfiles',
    // Legacy R2 buckets that still hold real ModelFile rows.
    'civitai-prod',
    'civitai-prod-settled',
    'civitai-delivery-worker-prod',
    'civitai-delivery-worker-prod-2023-05-01',
    'civitai-delivery-worker-prod-2023-10-01',
  ].filter((b): b is string => typeof b === 'string' && b.length > 0)
);

function isAllowedModelFileBucket(bucket: string | undefined): bucket is string {
  return !!bucket && MODEL_FILE_BUCKET_ALLOWLIST.has(bucket);
}

/**
 * Delete the S3 object referenced by a ModelFile URL.
 * Resolves the correct backend (R2 vs B2) and bucket from the URL itself —
 * never assumes a single bucket env var, since ModelFile URLs span historical
 * R2 buckets (civitai-delivery-worker-prod, civitai-prod-settled, ...).
 * Best-effort: callers should catch errors and log rather than blocking.
 *
 * Gated by MODEL_FILE_BUCKET_ALLOWLIST to prevent a user-supplied url from
 * pointing the delete at an arbitrary bucket (defense in depth — schema
 * validation is z.url() only).
 */
export async function deleteModelFileObject(url: string) {
  if (!url) return;
  const b2 = parseB2Url(url);
  if (b2) {
    if (!isAllowedModelFileBucket(b2.bucket)) {
      logToAxiom({
        type: 'warn',
        name: 'model-file-delete-s3-object-blocked',
        backend: 'b2',
        bucket: b2.bucket,
        url,
      });
      return;
    }
    return deleteObject(b2.bucket, b2.key, getB2S3Client());
  }
  const { key, bucket } = parseKey(url);
  if (!key || !bucket) return;
  if (!isAllowedModelFileBucket(bucket)) {
    logToAxiom({
      type: 'warn',
      name: 'model-file-delete-s3-object-blocked',
      backend: 'r2',
      bucket,
      url,
    });
    return;
  }
  await deleteObject(bucket, key);
}

/**
 * Batch-delete S3 objects for multiple ModelFile URLs.
 * Groups by `(backend, bucket)` and issues one DeleteObjects call per group —
 * S3 DeleteObjects is per-bucket, so different R2 buckets need separate calls.
 */
export async function deleteModelFileObjects(urls: string[]) {
  const groups = new Map<string, { backend: 'b2' | 'r2'; bucket: string; keys: string[] }>();

  for (const url of urls) {
    if (!url) continue;
    const b2 = parseB2Url(url);
    if (b2) {
      // Drop URLs targeting non-civitai buckets before they enter a group, so
      // a poisoned ModelFile.url can't piggyback on a legit DeleteObjects call.
      if (!isAllowedModelFileBucket(b2.bucket)) {
        logToAxiom({
          type: 'warn',
          name: 'model-file-delete-s3-object-blocked',
          backend: 'b2',
          bucket: b2.bucket,
          url,
        });
        continue;
      }
      const groupKey = `b2:${b2.bucket}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { backend: 'b2', bucket: b2.bucket, keys: [] };
        groups.set(groupKey, group);
      }
      group.keys.push(b2.key);
      continue;
    }
    const { key, bucket } = parseKey(url);
    if (!key || !bucket) continue;
    if (!isAllowedModelFileBucket(bucket)) {
      logToAxiom({
        type: 'warn',
        name: 'model-file-delete-s3-object-blocked',
        backend: 'r2',
        bucket,
        url,
      });
      continue;
    }
    const groupKey = `r2:${bucket}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { backend: 'r2', bucket, keys: [] };
      groups.set(groupKey, group);
    }
    group.keys.push(key);
  }

  // Resolve clients up-front so a missing-env throw in getB2S3Client doesn't
  // skip the R2 group via a synchronous escape from inside .map().
  // Use allSettled so one group's failure doesn't drop the others.
  // Track bucket per task so partial-failure logs can attribute Errors back to a group.
  const tasks: { bucket: string; promise: ReturnType<typeof deleteManyObjects> }[] = [];
  for (const group of groups.values()) {
    let client;
    if (group.backend === 'b2') {
      try {
        client = getB2S3Client();
      } catch {
        // B2 env not configured in this pod — skip B2 group, keep R2 deletes running.
        continue;
      }
    } else {
      try {
        client = getS3Client();
      } catch (error) {
        // R2 must be configured in every pod — surface the failure rather than silently skip.
        logToAxiom({
          type: 'error',
          name: 'model-file-delete-s3-objects-client-error',
          bucket: group.bucket,
          error,
        });
        continue;
      }
    }
    // S3/R2 DeleteObjects caps each call at 1000 keys — chunk to stay under the limit.
    for (let i = 0; i < group.keys.length; i += 1000) {
      tasks.push({
        bucket: group.bucket,
        promise: deleteManyObjects(group.bucket, group.keys.slice(i, i + 1000), client),
      });
    }
  }

  // DeleteObjects returns 200 even when individual keys fail — surface those via Errors.
  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      logToAxiom({
        type: 'error',
        name: 'model-file-delete-s3-objects-rejected',
        bucket: tasks[i].bucket,
        error: result.reason,
      });
      continue;
    }
    const errors = result.value.Errors;
    if (!errors?.length) continue;
    logToAxiom({
      type: 'error',
      name: 'model-file-delete-s3-objects-partial-failure',
      bucket: tasks[i].bucket,
      errorCount: errors.length,
      sample: errors.slice(0, 10).map((e) => ({ key: e.Key, code: e.Code, message: e.Message })),
    });
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
