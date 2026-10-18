import { createHash } from 'crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { env } from '~/env/server';
import { instrumentB2Client } from '~/server/prom/b2-put.metrics';
import {
  isTagIndexObjectKey,
  TagIndexObjectMissingError,
  TagIndexPayloadSizeError,
  type TagIndexObjectSweeper,
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
 * The snapshot bucket's own credentials (a B2 bucket and a key scoped to it). Without all of these
 * the store refuses; it never falls back to another client. The region is optional.
 */
export const TAG_INDEX_STORE_ENV = [
  'RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT',
  'RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY',
  'RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY',
] as const;

/** The snapshot bucket's client, from `TAG_INDEX_STORE_ENV`; one error names every missing var. */
function tagIndexS3ClientFromEnv(): S3Client {
  const missing = TAG_INDEX_STORE_ENV.filter((name) => !env[name]);
  if (missing.length) throw new Error(`${missing.join(', ')} not set`);
  return instrumentB2Client(
    new S3Client({
      credentials: {
        accessKeyId: env.RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY as string,
        secretAccessKey: env.RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY as string,
      },
      region: env.RESOURCE_INTENT_TAG_INDEX_B2_REGION ?? 'us-west-004',
      endpoint: env.RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT,
      forcePathStyle: true,
    })
  );
}

/**
 * Tag-index snapshot objects in `RESOURCE_INTENT_TAG_INDEX_BUCKET` under `TAG_INDEX_OBJECT_PREFIX`,
 * through that bucket's own client (`TAG_INDEX_STORE_ENV`) unless `opts.s3` is given. The prefix is
 * fixed, so the bucket alone separates environments. `delete` is retention's, and refuses any key
 * that is not a snapshot key there. Nothing lists the bucket (retention deletes only keys its own
 * rows name). On B2 a delete hides the file and its versions stay until a lifecycle rule purges
 * them, and a get of a never-written key reads as `NoSuchKey` only for a key holding `listBuckets`
 * besides `listFiles` (otherwise `AccessDenied`, which is retried rather than refused as missing).
 */
export function s3TagIndexObjects(
  opts: { s3?: S3Client; bucket?: string; prefix?: string } = {}
): TagIndexObjectSweeper {
  const bucket = opts.bucket ?? env.RESOURCE_INTENT_TAG_INDEX_BUCKET;
  if (!bucket) throw new Error('RESOURCE_INTENT_TAG_INDEX_BUCKET is not set');
  const shared = OTHER_BUCKETS.find((name) => env[name] === bucket);
  if (shared) throw new Error(`RESOURCE_INTENT_TAG_INDEX_BUCKET must not be the ${shared} bucket`);
  const prefix = opts.prefix ?? TAG_INDEX_OBJECT_PREFIX;
  const s3 = opts.s3 ?? tagIndexS3ClientFromEnv();
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
    get: async (key, expectedBytes, signal) => {
      signal?.throwIfAborted();
      const res = await s3
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })
        .catch((e: unknown) => {
          // NoSuchKey only: a wrong bucket (NoSuchBucket, also a 404) is a deployment error,
          // not this snapshot's.
          if ((e as { name?: string } | null)?.name === 'NoSuchKey')
            throw new TagIndexObjectMissingError(`tag index object ${key} not found`);
          throw e;
        });
      const body = res.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
      if (!body) throw new Error(`tag index object ${key} has no body`);
      if (signal?.aborted) {
        body.destroy?.();
        signal.throwIfAborted();
      }
      // An abort while the body stalls must not wait for its next chunk.
      const onAbort = () => body.destroy?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
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
        try {
          for await (const chunk of body) {
            if (signal?.aborted) {
              body.destroy?.();
              signal.throwIfAborted();
            }
            if (n + chunk.length > expectedBytes) throw sizeError(`over ${expectedBytes}`);
            bytes.set(chunk, n);
            hash.update(chunk);
            n += chunk.length;
          }
        } catch (e) {
          // A body the abort destroyed fails with a premature close: report the abort.
          signal?.throwIfAborted();
          throw e;
        }
        // A body destroyed by the abort can end early: that is the abort, not a short object.
        signal?.throwIfAborted();
        if (n !== expectedBytes) throw sizeError(String(n));
        return { bytes, sha256: hash.digest('hex') };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    delete: async (key) => {
      if (!isTagIndexObjectKey(prefix, key))
        throw new Error(`refusing to delete ${key}: not a tag index snapshot key under ${prefix}/`);
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
