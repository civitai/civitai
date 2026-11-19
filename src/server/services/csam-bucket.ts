import { newS3Client } from '~/utils/s3-client-factory';
import { env } from '~/env/server';

/** A client for the CSAM evidence bucket, and the bucket's name. */
export function getCsamBucket() {
  if (
    !env.CSAM_UPLOAD_KEY ||
    !env.CSAM_UPLOAD_SECRET ||
    !env.CSAM_UPLOAD_REGION ||
    !env.CSAM_UPLOAD_ENDPOINT ||
    !env.CSAM_BUCKET_NAME
  )
    throw new Error('missing CSAM env vars');
  const client = newS3Client({
    credentials: { accessKeyId: env.CSAM_UPLOAD_KEY, secretAccessKey: env.CSAM_UPLOAD_SECRET },
    region: env.CSAM_UPLOAD_REGION,
    endpoint: env.CSAM_UPLOAD_ENDPOINT,
  });
  return { client, Bucket: env.CSAM_BUCKET_NAME };
}

export const getCsamS3Client = () => getCsamBucket().client;
