import { S3Client } from '@aws-sdk/client-s3';
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
