import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectCommandInput,
  HeadObjectCommand,
  // PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server.mjs';

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

const DOWNLOAD_EXPIRATION = 60 * 60 * 24; // 24 hours
const UPLOAD_EXPIRATION = 60 * 60 * 12; // 12 hours
const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
export async function getMultipartPutUrl(
  key: string,
  size: number,
  s3: S3Client | null = null,
  bucket: string | null = null
) {
  if (!s3) s3 = getS3Client();

  if (!bucket) bucket = await getBucket();
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
export function parseKey(fileUrl: string) {
  const url = new URL(fileUrl);
  const bucketInPath = url.hostname === s3Host;
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
