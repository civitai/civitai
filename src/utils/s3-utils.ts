import { env } from '~/env/server.mjs';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  PutBucketCorsCommand,
  GetObjectCommandInput,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const missingEnvs = (): string[] => {
  const keys = [];
  if (!env.S3_UPLOAD_KEY) {
    keys.push('S3_UPLOAD_KEY');
  }
  if (!env.S3_UPLOAD_SECRET) {
    keys.push('S3_UPLOAD_SECRET');
  }
  if (!env.S3_UPLOAD_ENDPOINT) {
    keys.push('S3_UPLOAD_ENDPOINT');
  }
  if (!env.S3_UPLOAD_BUCKET) {
    keys.push('S3_UPLOAD_BUCKET');
  }
  return keys;
};

export async function setCors(s3: S3Client | null = null) {
  if (!s3) s3 = await getS3Client();
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: env.S3_UPLOAD_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['ETag'],
            AllowedMethods: ['PUT', 'GET'],
            AllowedOrigins: env.S3_ORIGINS ? env.S3_ORIGINS : ['*'],
          },
        ],
      },
    })
  );
}

export function getS3Client() {
  const missing = missingEnvs();
  if (missing.length > 0) throw new Error(`Next S3 Upload: Missing ENVs ${missing.join(', ')}`);

  return new S3Client({
    credentials: {
      accessKeyId: env.S3_UPLOAD_KEY,
      secretAccessKey: env.S3_UPLOAD_SECRET,
    },
    region: env.S3_UPLOAD_REGION,
    endpoint: env.S3_UPLOAD_ENDPOINT,
  });
}

export async function getPutUrl(key: string, s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();

  const bucket = env.S3_UPLOAD_BUCKET;
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 60 * 60, // 1 hour
  });
  return { url, bucket, key };
}

const UPLOAD_EXPIRATION = 60 * 60 * 3; // 3 hours
const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
export async function getMultipartPutUrl(key: string, size: number, s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();

  const bucket = env.S3_UPLOAD_BUCKET;
  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
  );

  const promises = [];
  for (let i = 0; i < Math.ceil(size / FILE_CHUNK_SIZE); i++) {
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
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: MultipartUploadPart[],
  s3: S3Client | null = null
) {
  if (!s3) s3 = getS3Client();
  const bucket = env.S3_UPLOAD_BUCKET;
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
  s3: S3Client | null = null
) {
  if (!s3) s3 = getS3Client();
  const bucket = env.S3_UPLOAD_BUCKET;
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
};

const keyParser = /https:\/\/.*?\/(.*)/;
function parseKey(key: string) {
  if (key.startsWith('http')) key = keyParser.exec(key)?.[1] ?? key;
  if (key.startsWith(env.S3_UPLOAD_BUCKET)) key = key.replace(`${env.S3_UPLOAD_BUCKET}/`, '');

  return key;
}

export async function getGetUrl(
  key: string,
  { s3, expiresIn = 60 * 60, fileName }: GetObjectOptions = {}
) {
  if (!s3) s3 = getS3Client();

  const command: GetObjectCommandInput = {
    Bucket: env.S3_UPLOAD_BUCKET,
    Key: parseKey(key),
  };
  if (fileName) command.ResponseContentDisposition = `attachment; filename="${fileName}"`;

  const url = await getSignedUrl(s3, new GetObjectCommand(command), { expiresIn });
  return { url, bucket: env.S3_UPLOAD_BUCKET, key };
}

export async function checkFileExists(key: string, s3: S3Client | null = null) {
  if (!s3) s3 = getS3Client();

  try {
    await s3.send(
      new HeadObjectCommand({
        Key: parseKey(key),
        Bucket: env.S3_UPLOAD_BUCKET,
      })
    );
  } catch {
    return false;
  }

  return true;
}
