import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { serverSchema } from '~/env/server-schema';
import { s3TagIndexObjects } from '~/server/services/resource-intent-tags/objects';
import {
  TagIndexObjectMissingError,
  TagIndexPayloadSizeError,
} from '~/server/services/resource-intent-tags/store';

/** The S3 adapter of the tag-index snapshot store, over a fake client. */

function fakeS3(get: { ContentLength?: number; bytes: Uint8Array; error?: unknown }) {
  const read = vi.fn(async () => get.bytes);
  const destroy = vi.fn();
  const sent: unknown[] = [];
  const s3 = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (get.error) throw get.error;
      if (cmd instanceof GetObjectCommand)
        return { ContentLength: get.ContentLength, Body: { transformToByteArray: read, destroy } };
      return {};
    }),
  } as unknown as S3Client;
  return { s3, sent, read, destroy };
}

describe('s3TagIndexObjects', () => {
  it('puts the bytes under the bucket and key', async () => {
    const { s3, sent } = fakeS3({ bytes: new Uint8Array() });
    const objects = s3TagIndexObjects({ s3, bucket: 'snapshots', prefix: 'p' });
    await objects.put('p/production/abc', Buffer.from('xyz'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'snapshots',
      Key: 'p/production/abc',
      Body: Buffer.from('xyz'),
    });
  });

  it('gets the bytes when the object is the expected size, or reports no size', async () => {
    for (const ContentLength of [3, undefined]) {
      const { s3, sent } = fakeS3({ ContentLength, bytes: Uint8Array.of(1, 2, 3) });
      const objects = s3TagIndexObjects({ s3, bucket: 'snapshots', prefix: 'p' });
      expect(await objects.get('k', 3)).toEqual(Buffer.of(1, 2, 3));
      expect((sent[0] as GetObjectCommand).input).toEqual({ Bucket: 'snapshots', Key: 'k' });
    }
  });

  it('refuses an object of another size without reading its body', async () => {
    const { s3, read, destroy } = fakeS3({ ContentLength: 4, bytes: Uint8Array.of(1, 2, 3, 4) });
    const objects = s3TagIndexObjects({ s3, bucket: 'snapshots', prefix: 'p' });
    await expect(objects.get('k', 3)).rejects.toBeInstanceOf(TagIndexPayloadSizeError);
    expect(read).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('reports a missing key as unservable, and rethrows any other failure (a missing bucket included) as it is', async () => {
    const notFound = Object.assign(new Error('gone'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    const missing = s3TagIndexObjects({
      s3: fakeS3({ bytes: new Uint8Array(), error: notFound }).s3,
      bucket: 'b',
      prefix: 'p',
    });
    await expect(missing.get('k', 3)).rejects.toBeInstanceOf(TagIndexObjectMissingError);
    const noBucket = Object.assign(new Error('no bucket'), {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
    const wrongBucket = s3TagIndexObjects({
      s3: fakeS3({ bytes: new Uint8Array(), error: noBucket }).s3,
      bucket: 'b',
      prefix: 'p',
    });
    await expect(wrongBucket.get('k', 3)).rejects.toBe(noBucket);
    const reset = new Error('connection reset');
    const failing = s3TagIndexObjects({
      s3: fakeS3({ bytes: new Uint8Array(), error: reset }).s3,
      bucket: 'b',
      prefix: 'p',
    });
    await expect(failing.get('k', 3)).rejects.toBe(reset);
  });

  it('takes the bucket and prefix from the environment, and refuses to start without a bucket', () => {
    const s3 = fakeS3({ bytes: new Uint8Array() }).s3;
    setEnv({ RESOURCE_INTENT_TAG_INDEX_BUCKET: undefined });
    expect(() => s3TagIndexObjects({ s3 })).toThrow(/RESOURCE_INTENT_TAG_INDEX_BUCKET is not set/);
    setEnv({
      RESOURCE_INTENT_TAG_INDEX_BUCKET: 'snapshots',
      RESOURCE_INTENT_TAG_INDEX_PREFIX: 'x/y',
    });
    expect(s3TagIndexObjects({ s3 }).prefix).toBe('x/y');
  });
});

describe('tag-index env', () => {
  const bucket = serverSchema.shape.RESOURCE_INTENT_TAG_INDEX_BUCKET;
  const prefix = serverSchema.shape.RESOURCE_INTENT_TAG_INDEX_PREFIX;

  it('bucket: optional, and an S3 bucket name when set', () => {
    expect(bucket.parse(undefined)).toBeUndefined();
    for (const ok of ['ri-snapshots.v1', 'abc', 'a'.repeat(63)]) expect(bucket.parse(ok)).toBe(ok);
    for (const bad of ['', 'Upper', 'a', 'ab', 'a'.repeat(64), '-lead', 'trail-', 'has/slash'])
      expect(bucket.safeParse(bad).success, bad).toBe(false);
  });

  it('prefix: defaults, and is slash-separated segments with no leading or trailing slash', () => {
    expect(prefix.parse(undefined)).toBe('resource-intent/tag-index');
    expect(prefix.parse('a/b_c-1')).toBe('a/b_c-1');
    for (const bad of ['', '/a', 'a/', 'a//b', 'a/../b', 'A'])
      expect(prefix.safeParse(bad).success, bad).toBe(false);
  });
});
