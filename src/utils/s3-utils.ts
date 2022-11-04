import { env } from '~/env/server.mjs';
import { S3, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const missingEnvs = (): string[] => {
  const keys = [];
  if (!env.S3_UPLOAD_KEY) {
    keys.push('S3_UPLOAD_KEY');
  }
  if (!env.S3_UPLOAD_SECRET) {
    keys.push('S3_UPLOAD_SECRET');
  }
  if (!env.S3_UPLOAD_REGION) {
    keys.push('S3_UPLOAD_REGION');
  }
  if (!env.S3_UPLOAD_ENDPOINT) {
    keys.push('S3_UPLOAD_ENDPOINT');
  }
  if (!env.S3_UPLOAD_BUCKET) {
    keys.push('S3_UPLOAD_BUCKET');
  }
  return keys;
};

export function getS3Client() {
  const missing = missingEnvs();
  if (missing.length > 0) throw new Error(`Next S3 Upload: Missing ENVs ${missing.join(', ')}`);

  return new S3({
    credentials: {
      accessKeyId: env.S3_UPLOAD_KEY,
      secretAccessKey: env.S3_UPLOAD_SECRET,
    },
    region: env.S3_UPLOAD_REGION,
    endpoint: env.S3_UPLOAD_ENDPOINT,
  });
}

export async function getPutUrl(key: string, s3: S3 | null = null) {
  if (!s3) s3 = getS3Client();

  const bucket = env.S3_UPLOAD_BUCKET;
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 60 * 60, // 1 hour
  });
  return { url, bucket, key };
}

const keyParser = /https:\/\/.*?\/(.*)/;
export async function getGetUrl(key: string, s3: S3 | null = null) {
  if (!s3) s3 = getS3Client();

  const bucket = env.S3_UPLOAD_BUCKET;
  if (key.startsWith('http')) key = keyParser.exec(key)?.[1] ?? key;
  if (key.startsWith(bucket)) key = key.replace(`${bucket}/`, '');

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 60 * 60, // 1 hour
  });
  return { url, bucket, key };
}
