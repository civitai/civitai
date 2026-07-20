import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server';

/**
 * S3-compatible client for the App Blocks W1 publish-request bundle store.
 *
 * Production points at ssd-minio-backups MinIO. Credentials are scoped to
 * the app-block-bundles bucket only (R/W on objects, ListBucket on the
 * bucket itself) — the bundle store is intentionally not the same S3
 * civitai uses for image uploads.
 *
 * forcePathStyle is required for MinIO addressing.
 */

let _client: S3Client | null = null;

export function getBundleS3Client(): S3Client {
  if (!_client) {
    if (
      !env.BUNDLE_S3_ENDPOINT ||
      !env.BUNDLE_S3_ACCESS_KEY_ID ||
      !env.BUNDLE_S3_SECRET_ACCESS_KEY
    ) {
      throw new Error(
        'Bundle S3 not configured: BUNDLE_S3_ENDPOINT / BUNDLE_S3_ACCESS_KEY_ID / BUNDLE_S3_SECRET_ACCESS_KEY must be set'
      );
    }
    _client = new S3Client({
      endpoint: env.BUNDLE_S3_ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: env.BUNDLE_S3_ACCESS_KEY_ID,
        secretAccessKey: env.BUNDLE_S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });
  }
  return _client;
}

export function getBundleBucket(): string {
  if (!env.BUNDLE_S3_BUCKET) {
    throw new Error('BUNDLE_S3_BUCKET not configured');
  }
  return env.BUNDLE_S3_BUCKET;
}

/** Build the canonical S3 key for a bundle from its content SHA. */
export function bundleKey(sha256: string): string {
  return `bundles/${sha256}.zip`;
}

/** Derive a per-review staging key for agent-review bundles. */
export function agentReviewBundleKey(publishRequestId: string, sha: string): string {
  return `agent-reviews/${publishRequestId}/${sha}.zip`;
}

/** Upload a buffer to the bundle store at the given key. */
export async function stageBundleObject(key: string, buffer: Buffer): Promise<void> {
  const client = getBundleS3Client();
  const bucket = getBundleBucket();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
    })
  );
}

/**
 * Best-effort delete of the per-review staged bundle object(s) for a publish
 * request. The git-push review path stages a Forgejo-reconstructed ZIP under
 * `agent-reviews/<publishRequestId>/<sha>.zip` (see `agentReviewBundleKey`); on
 * teardown we remove it so staged ZIPs don't accumulate. Keyed by the
 * `agent-reviews/<publishRequestId>/` prefix (the sha isn't known at teardown,
 * and a re-review could stage a second sha), so a LIST-then-DELETE sweeps every
 * staged object for the request.
 *
 * NEVER throws — called from the best-effort decision-path teardown. A missing
 * object / absent config / list error is swallowed (a MinIO bucket
 * lifecycle-expiry rule on the `agent-reviews/` prefix is the intended infra
 * backstop — a follow-up, not this PR — so a missed delete self-heals).
 */
export async function deleteStagedBundle(publishRequestId: string): Promise<void> {
  if (!publishRequestId) return;
  try {
    const client = getBundleS3Client();
    const bucket = getBundleBucket();
    const prefix = `agent-reviews/${publishRequestId}/`;
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
    );
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
    for (const Key of keys) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
      } catch {
        /* best-effort per-object — lifecycle-expiry backstops a missed delete */
      }
    }
  } catch {
    /* best-effort — never fail teardown on a staged-object cleanup error */
  }
}

/** Sign a short-TTL read-only GET URL for a bundle object. */
export async function presignBundleGet(key: string, ttlSeconds: number): Promise<string> {
  const client = getBundleS3Client();
  const bucket = getBundleBucket();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: ttlSeconds }
  );
}
