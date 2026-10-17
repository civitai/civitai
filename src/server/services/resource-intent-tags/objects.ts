import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { env } from '~/env/server';
import { getS3Client } from '~/utils/s3-utils';
import {
  TagIndexObjectMissingError,
  TagIndexPayloadSizeError,
  type TagIndexObjectStore,
} from './store';

/**
 * Tag-index snapshot objects in `RESOURCE_INTENT_TAG_INDEX_BUCKET` under
 * `RESOURCE_INTENT_TAG_INDEX_PREFIX`, through the S3_UPLOAD_* client.
 */
export function s3TagIndexObjects(
  opts: { s3?: S3Client; bucket?: string; prefix?: string } = {}
): TagIndexObjectStore {
  const bucket = opts.bucket ?? env.RESOURCE_INTENT_TAG_INDEX_BUCKET;
  if (!bucket) throw new Error('RESOURCE_INTENT_TAG_INDEX_BUCKET is not set');
  const prefix = opts.prefix ?? env.RESOURCE_INTENT_TAG_INDEX_PREFIX;
  const s3 = opts.s3 ?? getS3Client();
  return {
    prefix,
    put: async (key, bytes) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/octet-stream',
        })
      );
    },
    get: async (key, expectedBytes) => {
      const res = await s3
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .catch((e: unknown) => {
          // NoSuchKey only: a wrong bucket (NoSuchBucket, also a 404) is a deployment error,
          // not this snapshot's.
          if ((e as { name?: string } | null)?.name === 'NoSuchKey')
            throw new TagIndexObjectMissingError(`tag index object ${key} not found`);
          throw e;
        });
      if (!res.Body) throw new Error(`tag index object ${key} has no body`);
      // Refuse before reading: the body of a wrong object can be far larger than any snapshot.
      if (typeof res.ContentLength === 'number' && res.ContentLength !== expectedBytes) {
        (res.Body as { destroy?: () => void }).destroy?.();
        throw new TagIndexPayloadSizeError(
          `tag index object ${key} is ${res.ContentLength} bytes, manifest says ${expectedBytes}`
        );
      }
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
  };
}
