import { createHash } from 'crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { serverSchema } from '~/env/server-schema';
import {
  s3TagIndexObjects,
  TAG_INDEX_OBJECT_PREFIX,
} from '~/server/services/resource-intent-tags/objects';
import {
  TagIndexObjectMissingError,
  TagIndexPayloadSizeError,
} from '~/server/services/resource-intent-tags/store';

/** The S3 adapter of the tag-index snapshot store, over a fake client. */

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A GetObject body that yields `chunks` and records how many it handed out. */
function streamBody(chunks: Uint8Array[]) {
  const state = { yielded: 0 };
  const destroy = vi.fn();
  const body = {
    destroy,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        state.yielded++;
        yield c;
      }
    },
  };
  return { body, state, destroy };
}

function fakeS3(get: { ContentLength?: number; chunks?: Uint8Array[]; error?: unknown }) {
  const stream = streamBody(get.chunks ?? []);
  const sent: unknown[] = [];
  const s3 = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (get.error) throw get.error;
      if (cmd instanceof GetObjectCommand)
        return { ContentLength: get.ContentLength, Body: stream.body };
      return {};
    }),
  } as unknown as S3Client;
  return { s3, sent, ...stream };
}

const objectsOver = (s3: S3Client) => s3TagIndexObjects({ s3, bucket: 'snapshots', prefix: 'p' });

describe('s3TagIndexObjects', () => {
  it('puts the bytes under the bucket and key', async () => {
    const { s3, sent } = fakeS3({});
    await objectsOver(s3).put('p/abc', Buffer.from('xyz'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'snapshots',
      Key: 'p/abc',
      Body: Buffer.from('xyz'),
    });
  });

  it('streams the body into the bytes and their sha256, with or without a reported size', async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)];
    for (const ContentLength of [6, undefined]) {
      const { s3, sent } = fakeS3({ ContentLength, chunks });
      const got = await objectsOver(s3).get('k', 6);
      expect(got.bytes).toEqual(Buffer.of(1, 2, 3, 4, 5, 6));
      expect(got.sha256).toBe(sha(Buffer.of(1, 2, 3, 4, 5, 6)));
      expect((sent[0] as GetObjectCommand).input).toEqual({ Bucket: 'snapshots', Key: 'k' });
    }
  });

  it('refuses an object of another reported size without reading its body', async () => {
    const { s3, state, destroy } = fakeS3({
      ContentLength: 4,
      chunks: [Uint8Array.of(1, 2, 3, 4)],
    });
    const err = await objectsOver(s3)
      .get('k', 3)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TagIndexPayloadSizeError);
    expect((err as Error).message).toMatch(/is 4 bytes/);
    expect(state.yielded).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that runs past the expected size, at the chunk that overflows', async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5)];
    const { s3, state, destroy } = fakeS3({ chunks });
    const err = await objectsOver(s3)
      .get('k', 3)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TagIndexPayloadSizeError);
    expect((err as Error).message).toMatch(/is over 3 bytes/);
    expect(state.yielded).toBe(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that ends short of the expected size', async () => {
    const { s3 } = fakeS3({ ContentLength: 5, chunks: [Uint8Array.of(1, 2), Uint8Array.of(3)] });
    const err = await objectsOver(s3)
      .get('k', 5)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TagIndexPayloadSizeError);
    expect((err as Error).message).toMatch(/is 3 bytes/);
  });

  it('an abort stops the download mid-stream and destroys the body', async () => {
    const abort = new AbortController();
    const destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield Uint8Array.of(1, 2);
        abort.abort();
        yield Uint8Array.of(3);
        yield Uint8Array.of(4);
      },
    };
    const sent: { abortSignal?: AbortSignal }[] = [];
    const s3 = {
      send: vi.fn(async (_cmd: unknown, opts: { abortSignal?: AbortSignal }) => {
        sent.push(opts);
        return { ContentLength: 4, Body: body };
      }),
    } as unknown as S3Client;
    const e = await objectsOver(s3)
      .get('k', 4, abort.signal)
      .catch((x: unknown) => x);
    expect((e as Error).name).toBe('AbortError');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(sent[0].abortSignal).toBe(abort.signal);
    // Already aborted: nothing is sent.
    await expect(objectsOver(s3).get('k', 4, abort.signal)).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it('reports a missing key as unservable, and rethrows any other failure (a missing bucket included) as it is', async () => {
    const notFound = Object.assign(new Error('gone'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    await expect(objectsOver(fakeS3({ error: notFound }).s3).get('k', 3)).rejects.toBeInstanceOf(
      TagIndexObjectMissingError
    );
    const noBucket = Object.assign(new Error('no bucket'), {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
    await expect(objectsOver(fakeS3({ error: noBucket }).s3).get('k', 3)).rejects.toBe(noBucket);
    const reset = new Error('connection reset');
    await expect(objectsOver(fakeS3({ error: reset }).s3).get('k', 3)).rejects.toBe(reset);
  });

  it('takes the bucket from the environment under the fixed prefix, and refuses to start without one', () => {
    const s3 = fakeS3({}).s3;
    setEnv({ RESOURCE_INTENT_TAG_INDEX_BUCKET: undefined });
    expect(() => s3TagIndexObjects({ s3 })).toThrow(/RESOURCE_INTENT_TAG_INDEX_BUCKET is not set/);
    setEnv({ RESOURCE_INTENT_TAG_INDEX_BUCKET: 'snapshots' });
    // Stored objects live under this prefix; changing it orphans every one of them.
    expect(s3TagIndexObjects({ s3 }).prefix).toBe('resource-intent/tag-index');
  });

  it.each([
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
  ])('refuses to start on the %s bucket', (name) => {
    const s3 = fakeS3({}).s3;
    setEnv({ RESOURCE_INTENT_TAG_INDEX_BUCKET: 'shared-bucket', [name]: 'other-bucket' });
    expect(s3TagIndexObjects({ s3 }).prefix).toBe(TAG_INDEX_OBJECT_PREFIX);
    setEnv({ [name]: 'shared-bucket' });
    expect(() => s3TagIndexObjects({ s3 })).toThrow(new RegExp(`must not be the ${name} bucket`));
    setEnv({ [name]: undefined });
  });
});

describe('s3TagIndexObjects listing and deleting (retention)', () => {
  const HEX = 'c'.repeat(64);

  it("lists every page under <prefix>/, carrying each object's time and size", async () => {
    const t1 = new Date('2026-11-01T00:00:00Z');
    const pages = [
      {
        Contents: [{ Key: `p/${HEX}`, LastModified: t1, Size: 7 }, { Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      },
      { Contents: [{ Key: 'p/other' }], IsTruncated: false },
    ];
    const sent: ListObjectsV2Command[] = [];
    const s3 = {
      send: vi.fn(async (cmd: ListObjectsV2Command) => {
        sent.push(cmd);
        return pages[sent.length - 1];
      }),
    } as unknown as S3Client;
    const before = Date.now();
    const listed = [];
    for await (const o of objectsOver(s3).list()) listed.push(o);
    expect(sent.map((c) => c.input)).toEqual([
      { Bucket: 'snapshots', Prefix: 'p/', ContinuationToken: undefined },
      { Bucket: 'snapshots', Prefix: 'p/', ContinuationToken: 'next' },
    ]);
    expect(listed.map((o) => [o.key, o.bytes])).toEqual([
      [`p/${HEX}`, 7],
      ['p/other', 0],
    ]);
    expect(listed[0].lastModified).toEqual(t1);
    // No timestamp reads as just written: never old enough to delete.
    expect(listed[1].lastModified.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('deletes a snapshot key, and refuses any other key without sending anything', async () => {
    const { s3, sent } = fakeS3({});
    const objects = objectsOver(s3);
    await objects.delete(`p/${HEX}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((sent[0] as DeleteObjectCommand).input).toEqual({
      Bucket: 'snapshots',
      Key: `p/${HEX}`,
    });
    for (const key of [
      `q/${HEX}`,
      'p/README',
      `p/${HEX.toUpperCase()}`,
      `p/x/${HEX.slice(2)}`,
      `${HEX}`,
    ])
      await expect(objects.delete(key)).rejects.toThrow(/not a tag index snapshot key/);
    expect(sent).toHaveLength(1);
  });
});

describe('tag-index env', () => {
  const bucket = serverSchema.shape.RESOURCE_INTENT_TAG_INDEX_BUCKET;

  it('bucket: optional, an empty value reads as unset, and an S3 bucket name when set', () => {
    expect(bucket.parse(undefined)).toBeUndefined();
    expect(bucket.parse('')).toBeUndefined();
    for (const ok of ['ri-snapshots.v1', 'abc', 'a'.repeat(63)]) expect(bucket.parse(ok)).toBe(ok);
    for (const bad of ['Upper', 'a', 'ab', 'a'.repeat(64), '-lead', 'trail-', 'has/slash'])
      expect(bucket.safeParse(bad).success, bad).toBe(false);
  });
});
