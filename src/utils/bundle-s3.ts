import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

/**
 * Build the per-review staging key for a bundle reconstructed from Forgejo (the
 * git-push publish path never uploads a ZIP, so there is no canonical
 * `bundles/<sha>.zip` object to presign). Kept under a distinct `agent-review/`
 * prefix so these transient staged objects are trivially lifecycle-expirable and
 * never collide with the canonical bundle store.
 */
export function agentReviewBundleKey(publishRequestId: string, sha256: string): string {
  return `agent-review/${publishRequestId}-${sha256}.zip`;
}

/**
 * Stage a bundle ZIP into the bundle bucket at `key`. Used to persist a
 * Forgejo-reconstructed bundle so the review agent pod can pull ONE presigned
 * object (it never talks to Forgejo). Overwrites are fine — the key is content-
 * addressed by (publishRequestId, sha).
 */
export async function stageBundleObject(
  key: string,
  body: Buffer,
  contentType = 'application/zip'
): Promise<void> {
  const client = getBundleS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: getBundleBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * Presign a read-only GET of a bundle object, valid for `ttlSeconds`. The URL is
 * signed against the IN-CLUSTER MinIO endpoint (BUNDLE_S3_ENDPOINT, e.g.
 * `http://minio.<ns>.svc.cluster.local`) so it is reachable from a pod's init
 * curl; it is NOT a public URL. Short TTL bounds exposure of the presigned URL
 * that is injected into the agent pod env.
 */
export async function presignBundleGet(key: string, ttlSeconds: number): Promise<string> {
  const client = getBundleS3Client();
  const cmd = new GetObjectCommand({ Bucket: getBundleBucket(), Key: key });
  return getSignedUrl(client, cmd, { expiresIn: ttlSeconds });
}
