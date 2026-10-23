import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server';

/**
 * FORKABLE APPS — the store a fork's starting files are staged in, for the hosted sandbox service
 * to download once (`POST /v1/sandboxes` with a `seed`).
 *
 * 🔴 A DEDICATED BUCKET ON A DEDICATED HOST. The sandbox service fetches a seed only from the
 * exact hostnames in its `SEED_URL_HOSTS`, and any signed-in user can call it directly with any
 * URL on those hosts. So the host must serve civitai's fork seeds and nothing else — never a
 * bucket users can upload to. Path-style addressing (`forcePathStyle`) keeps the presigned URL's
 * host equal to `APP_FORK_SEED_S3_ENDPOINT`'s, which is the one value `SEED_URL_HOSTS` lists.
 */

/** How long a presigned seed URL is valid. The sandbox service downloads it within seconds. */
export const FORK_SEED_PRESIGN_TTL_SECONDS = 600;

/** The seed store's settings, or `null` when this environment has none. */
export function forkSeedStoreConfig(): {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  const endpoint = env.APP_FORK_SEED_S3_ENDPOINT;
  const bucket = env.APP_FORK_SEED_S3_BUCKET;
  const accessKeyId = env.APP_FORK_SEED_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.APP_FORK_SEED_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

/**
 * Whether `url` is one the sandbox service will accept from this store: HTTPS, no credentials, no
 * port (not even `:443`), and exactly the configured endpoint's hostname.
 */
export function isAcceptableSeedUrl(url: string, endpoint: string): boolean {
  try {
    const u = new URL(url);
    const host = new URL(endpoint).hostname;
    return (
      u.protocol === 'https:' && !u.username && !u.password && u.port === '' && u.hostname === host
    );
  } catch {
    return false;
  }
}

function client(config: NonNullable<ReturnType<typeof forkSeedStoreConfig>>): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  });
}

/** The object key a fork's seed is stored under. */
export function forkSeedKey(forkSlug: string, sha256: string): string {
  return `fork-seeds/${forkSlug}/${sha256}.zip`;
}

/**
 * Upload `buffer` under `key` and return a GET URL for it, valid for
 * {@link FORK_SEED_PRESIGN_TTL_SECONDS}. Throws when the store is not configured.
 */
export async function stageForkSeed(key: string, buffer: Buffer): Promise<string> {
  const config = forkSeedStoreConfig();
  if (!config) throw new Error('fork seed store not configured');
  const s3 = client(config);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'application/zip',
    })
  );
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
    expiresIn: FORK_SEED_PRESIGN_TTL_SECONDS,
  });
}
