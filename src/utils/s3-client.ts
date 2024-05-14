import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
  UploadPartCommand,
  ListObjectsV2Command,
  _Object,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '~/env/server.mjs';

const DOWNLOAD_EXPIRATION = 60 * 60 * 24; // 24 hours
const UPLOAD_EXPIRATION = 60 * 60 * 12; // 12 hours
const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB

type S3ConstructorProps = {
  /** unique name used for error logging */
  name: string;
  uploadKey?: string;
  uploadSecret?: string;
  uploadEndpoint?: string;
  uploadRegion?: string;
};
type BaseS3MethodProps = { bucket: string; key: string };
type MultipartUploadPart = {
  ETag: string;
  PartNumber: number;
};

type HasKeys<T> = {
  [P in keyof T]: any;
};

function createS3Client({
  name,
  uploadKey,
  uploadSecret,
  uploadEndpoint,
  uploadRegion,
}: S3ConstructorProps) {
  const keys: string[] = [];
  if (!uploadKey) keys.push('uploadKey');
  if (!uploadSecret) keys.push('uploadSecret');
  if (!uploadEndpoint) keys.push('uploadEndpoint');
  if (keys.length) throw new Error(`${name} S3Client: missing vars ${keys.join(', ')}`);

  return new AwsS3Client({
    credentials: {
      accessKeyId: uploadKey as string,
      secretAccessKey: uploadSecret as string,
    },
    region: uploadRegion,
    endpoint: uploadEndpoint,
  });
}

export class S3Client {
  client: AwsS3Client;

  constructor(props: S3ConstructorProps) {
    this.client = createS3Client(props);
  }

  async getPutUrl({ bucket, key }: BaseS3MethodProps) {
    return await getSignedUrl(this.client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: UPLOAD_EXPIRATION,
    });
  }

  async deleteObject({ bucket, key }: BaseS3MethodProps) {
    return this.client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
  }

  async deleteManyObjects({ bucket, keys }: { bucket: string; keys: string[] }) {
    return this.client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.map((key) => ({ Key: key })),
        },
      })
    );
  }

  async getMultipartPutUrl({ bucket, key, size }: BaseS3MethodProps & { size: number }) {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
    );
    const promises = [];
    for (let i = 0; i < Math.ceil(size / FILE_CHUNK_SIZE); i++) {
      promises.push(
        getSignedUrl(
          this.client,
          new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: i + 1 }),
          { expiresIn: UPLOAD_EXPIRATION }
        ).then((url) => ({ url, partNumber: i + 1 }))
      );
    }
    const urls = await Promise.all(promises);
    return { urls, uploadId: UploadId };
  }

  async completeMultipartUpload({
    bucket,
    key,
    uploadId,
    parts,
  }: BaseS3MethodProps & { uploadId: string; parts: MultipartUploadPart[] }) {
    return this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  }

  async abortMultipartUpload({ bucket, key, uploadId }: BaseS3MethodProps & { uploadId: string }) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      })
    );
  }

  async getGetUrl({
    bucket,
    key,
    expiresIn = DOWNLOAD_EXPIRATION,
    filename,
  }: BaseS3MethodProps & { expiresIn: number; filename?: string }) {
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: filename ? `attachment; filename="${filename}"` : undefined,
      }),
      { expiresIn }
    );
  }

  async checkFileExists({ bucket, key }: BaseS3MethodProps) {
    return await this.client.send(
      new HeadObjectCommand({
        Key: key,
        Bucket: bucket,
      })
    );
  }

  async listObjects({
    bucket,
    limit,
    cursor,
    prefix,
  }: {
    bucket: string;
    limit?: number;
    cursor?: string;
    prefix?: string;
  }) {
    let isTruncated = true;
    let contents: _Object[] = [];
    let nextCursor: string | undefined;

    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: limit,
      ContinuationToken: cursor,
    });
    while (isTruncated) {
      const { Contents, IsTruncated, NextContinuationToken } = await this.client.send(command);
      if (Contents) contents = contents.concat(Contents);
      isTruncated = IsTruncated ?? false;
      nextCursor = NextContinuationToken;
      command.input.ContinuationToken = NextContinuationToken;
    }

    return { items: contents, nextCursor };
  }
}

export class S3Bucket implements HasKeys<S3Client> {
  bucket: string;
  client: S3Client;

  constructor({ bucket, client }: { bucket: string; client: S3Client }) {
    // handle missing env vars
    if (!bucket) throw new Error('s3 bucket var missing');
    this.bucket = bucket;
    this.client = client;
  }

  async getPutUrl(props: { key: string }) {
    return this.client.getPutUrl({ bucket: this.bucket, ...props });
  }

  async deleteObject(props: { key: string }) {
    return this.client.deleteObject({ bucket: this.bucket, ...props });
  }

  async deleteManyObjects(props: { keys: string[] }) {
    return this.client.deleteManyObjects({ bucket: this.bucket, ...props });
  }

  async getMultipartPutUrl(props: { key: string; size: number }) {
    return this.client.getMultipartPutUrl({ bucket: this.bucket, ...props });
  }

  async completeMultipartUpload(props: {
    key: string;
    uploadId: string;
    parts: MultipartUploadPart[];
  }) {
    return this.client.completeMultipartUpload({ bucket: this.bucket, ...props });
  }

  async abortMultipartUpload(props: { key: string; uploadId: string }) {
    return this.client.abortMultipartUpload({ bucket: this.bucket, ...props });
  }

  async getGetUrl(props: { key: string; expiresIn: number; filename?: string }) {
    return this.client.getGetUrl({ bucket: this.bucket, ...props });
  }

  async checkFileExists(props: { key: string }) {
    return this.client.checkFileExists({ bucket: this.bucket, ...props });
  }

  async listObjects(props: { limit?: number; cursor?: string; prefix?: string }) {
    return this.client.listObjects({ bucket: this.bucket, ...props });
  }
}

export const baseS3Client = new S3Client({
  name: 'base-s3-client',
  uploadKey: env.S3_UPLOAD_KEY,
  uploadSecret: env.S3_UPLOAD_SECRET,
  uploadEndpoint: env.S3_UPLOAD_ENDPOINT,
  uploadRegion: env.S3_UPLOAD_REGION,
});

// export const csamS3Client = new S3Client({
//   name: 'csam-s3-client',
//   uploadKey: env.CSAM_UPLOAD_KEY,
//   uploadSecret: env.CSAM_UPLOAD_SECRET,
//   uploadEndpoint: env.CSAM_UPLOAD_REGION,
//   uploadRegion: env.CSAM_UPLOAD_ENDPOINT,
// });

export const S3 = {
  uploadBucket: new S3Bucket({ client: baseS3Client, bucket: env.S3_UPLOAD_BUCKET }),
  imageBucket: new S3Bucket({ client: baseS3Client, bucket: env.S3_IMAGE_UPLOAD_BUCKET }),
  imageCacheBucket: new S3Bucket({ client: baseS3Client, bucket: env.S3_IMAGE_CACHE_BUCKET }),
  // csamBucket: new S3Bucket({ client: csamS3Client, bucket: env.CSAM_BUCKET_NAME }),
};
