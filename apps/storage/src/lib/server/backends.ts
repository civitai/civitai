// Resolves a StorageBackend (from the wire schema) to a configured, memoized low-level S3 client.
// This is where the service's bucket CREDENTIALS live — read from env, one config per backend. Callers
// (routes) never see creds; they name a backend and get its client. Mirrors how apps/notifications
// keeps its DB creds in lib/server/clients/db.ts.
import type { StorageBackend } from '@civitai/storage';
import { createS3Client, type S3Backend, type S3BackendConfig } from './s3';

const B2_DEFAULT_REGION = 'us-west-004';

function resolveConfig(backend: StorageBackend): S3BackendConfig {
  const env = process.env;
  switch (backend) {
    case 'default':
      return {
        endpoint: env.S3_UPLOAD_ENDPOINT ?? '',
        accessKey: env.S3_UPLOAD_KEY ?? '',
        secretKey: env.S3_UPLOAD_SECRET ?? '',
        bucket: env.S3_UPLOAD_BUCKET,
        region: env.S3_UPLOAD_REGION,
      };
    case 'b2':
      return {
        endpoint: env.S3_UPLOAD_B2_ENDPOINT ?? '',
        accessKey: env.S3_UPLOAD_B2_ACCESS_KEY ?? '',
        secretKey: env.S3_UPLOAD_B2_SECRET_KEY ?? '',
        bucket: env.S3_UPLOAD_B2_BUCKET ?? 'civitai-modelfiles',
        region: env.S3_UPLOAD_B2_REGION ?? B2_DEFAULT_REGION,
        forcePathStyle: true,
      };
    case 'b2Image':
      return {
        endpoint: env.S3_IMAGE_B2_ENDPOINT ?? '',
        accessKey: env.S3_IMAGE_B2_ACCESS_KEY ?? '',
        secretKey: env.S3_IMAGE_B2_SECRET_KEY ?? '',
        bucket: env.S3_IMAGE_B2_BUCKET ?? 'civitai-media-uploads',
        region: env.S3_IMAGE_B2_REGION ?? B2_DEFAULT_REGION,
        forcePathStyle: true,
      };
    case 'csam':
      return {
        endpoint: env.CSAM_UPLOAD_ENDPOINT ?? '',
        accessKey: env.CSAM_UPLOAD_KEY ?? '',
        secretKey: env.CSAM_UPLOAD_SECRET ?? '',
        bucket: env.CSAM_BUCKET_NAME || undefined,
        region: env.CSAM_UPLOAD_REGION || undefined,
      };
  }
}

const cache = new Map<StorageBackend, S3Backend>();

/** Get the (memoized) S3 client for a backend. Throws if the backend's endpoint/creds are unset — a
 * misconfigured backend must fail the request loudly, not silently target the wrong store. */
export function getBackendClient(backend: StorageBackend): S3Backend {
  const cached = cache.get(backend);
  if (cached) return cached;
  const config = resolveConfig(backend);
  const missing: string[] = [];
  if (!config.endpoint) missing.push('endpoint');
  if (!config.accessKey) missing.push('accessKey');
  if (!config.secretKey) missing.push('secretKey');
  if (missing.length) {
    throw new Error(
      `[storage] backend "${backend}" is not configured: missing ${missing.join(', ')}`
    );
  }
  const built = createS3Client(config);
  cache.set(backend, built);
  return built;
}
