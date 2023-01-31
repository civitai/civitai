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
    expiresIn: UPLOAD_EXPIRATION,
  });
  return { url, bucket, key };
}

const DOWNLOAD_EXPIRATION = 60 * 60 * 24; // 24 hours
const UPLOAD_EXPIRATION = 60 * 60 * 12; // 12 hours
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
  bucket?: string;
};

const buckets = [env.S3_UPLOAD_BUCKET, env.S3_SETTLED_BUCKET];
const keyParser = new RegExp(`https:\\/\\/([\\w\\-]*)\\.?${env.CF_ACCOUNT_ID}.*?\\/(.+)`, 'i');
function parseKey(key: string) {
  let bucket = null;
  if (key.startsWith('http')) [, bucket, key] = keyParser.exec(key) ?? [, null, key];
  for (const b of buckets) {
    if (!key.startsWith(b + '/')) continue;
    bucket = b;
    key = key.replace(`${bucket}/`, '');
    break;
  }

  return { key, bucket };
}

export async function getGetUrl(
  key: string,
  { s3, expiresIn = DOWNLOAD_EXPIRATION, fileName, bucket }: GetObjectOptions = {}
) {
  if (!s3) s3 = getS3Client();

  const { key: parsedKey, bucket: parsedBucket } = parseKey(key);
  if (!bucket) bucket = parsedBucket ?? env.S3_UPLOAD_BUCKET;
  const command: GetObjectCommandInput = {
    Bucket: bucket,
    Key: parsedKey,
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
