import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { env } from '~/env/server';
import { getS3Client } from '~/utils/s3-utils';
import {
  TagIndexObjectMissingError,
  TagIndexPayloadSizeError,
  type TagIndexObjectStore,
} from './store';

export const TAG_INDEX_OBJECT_PREFIX = 'resource-intent/tag-index';

/** Every other bucket the app is configured with; snapshots must not share one. */
const OTHER_BUCKETS = [
  'S3_UPLOAD_BUCKET',
  'S3_IMAGE_UPLOAD_BUCKET',
  'S3_IMAGE_CACHE_BUCKET',
  'S3_IMAGE_CACHE_BUCKET_OLD',
  'CSAM_BUCKET_NAME',
  'S3_VAULT_BUCKET',
  'S3_UPLOAD_B2_BUCKET',
  'S3_UPLOAD_B2_QUARANTINE_BUCKET',
  'S3_IMAGE_B2_BUCKET',
  'APPEAL_TRAINING_B2_BUCKET',
  'SCAN_LABEL_P3_B2_BUCKET',
  'BUNDLE_S3_BUCKET',
] as const;

/**
 * Tag-index snapshot objects in `RESOURCE_INTENT_TAG_INDEX_BUCKET` under `TAG_INDEX_OBJECT_PREFIX`,
 * through the S3_UPLOAD_* client. The prefix is fixed, so the bucket alone separates environments.
 */
export function s3TagIndexObjects(
  opts: { s3?: S3Client; bucket?: string; prefix?: string } = {}
): TagIndexObjectStore {
  const bucket = opts.bucket ?? env.RESOURCE_INTENT_TAG_INDEX_BUCKET;
  if (!bucket) throw new Error('RESOURCE_INTENT_TAG_INDEX_BUCKET is not set');
  const shared = OTHER_BUCKETS.find((name) => env[name] === bucket);
  if (shared) throw new Error(`RESOURCE_INTENT_TAG_INDEX_BUCKET must not be the ${shared} bucket`);
  const prefix = opts.prefix ?? TAG_INDEX_OBJECT_PREFIX;
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
      const body = res.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
      if (!body) throw new Error(`tag index object ${key} has no body`);
      const sizeError = (got: string) => {
        body.destroy?.();
        return new TagIndexPayloadSizeError(
          `tag index object ${key} is ${got} bytes, manifest says ${expectedBytes}`
        );
      };
      // Refuse before reading: the body of a wrong object can be far larger than any snapshot.
      if (typeof res.ContentLength === 'number' && res.ContentLength !== expectedBytes)
        throw sizeError(String(res.ContentLength));
      // One buffer of the known size, filled and hashed as the body streams in.
      const bytes = Buffer.allocUnsafe(expectedBytes);
      const hash = createHash('sha256');
      let n = 0;
      for await (const chunk of body) {
        if (n + chunk.length > expectedBytes) throw sizeError(`over ${expectedBytes}`);
        bytes.set(chunk, n);
        hash.update(chunk);
        n += chunk.length;
      }
      if (n !== expectedBytes) throw sizeError(String(n));
      return { bytes, sha256: hash.digest('hex') };
    },
  };
}
