import { createHash } from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { env } from '~/env/server';
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
    expect(destroy).toHaveBeenCalled();
    expect(sent[0].abortSignal).toBe(abort.signal);
    // Already aborted: nothing is sent.
    await expect(objectsOver(s3).get('k', 4, abort.signal)).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['fails with a premature close', true],
    ['simply ends', false],
  ])(
    'a body the abort destroys, which then %s, is reported as the abort, not a short object',
    async (_what, throws) => {
      const abort = new AbortController();
      let destroyed = false;
      const body = {
        destroy: () => {
          destroyed = true;
        },
        async *[Symbol.asyncIterator]() {
          yield Uint8Array.of(1, 2);
          abort.abort();
          await new Promise((r) => setTimeout(r, 0));
          if (destroyed && throws)
            throw Object.assign(new Error('premature close'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
            });
          if (destroyed) return;
          yield Uint8Array.of(3, 4);
        },
      };
      const s3 = {
        send: vi.fn(async () => ({ ContentLength: 4, Body: body })),
      } as unknown as S3Client;
      const e = await objectsOver(s3)
        .get('k', 4, abort.signal)
        .catch((x: unknown) => x);
      expect((e as Error).name).toBe('AbortError');
      expect(e).not.toBeInstanceOf(TagIndexPayloadSizeError);
    }
  );

  it('an abort that lands while the request is in flight allocates nothing for the body', async () => {
    const abort = new AbortController();
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    onTestFinished(() => alloc.mockRestore());
    const s3 = {
      send: vi.fn(async () => {
        abort.abort();
        return {
          ContentLength: 4,
          Body: {
            destroy: vi.fn(),
            async *[Symbol.asyncIterator]() {
              yield* [];
            },
          },
        };
      }),
    } as unknown as S3Client;
    const e = await objectsOver(s3)
      .get('k', 4, abort.signal)
      .catch((x: unknown) => x);
    expect((e as Error).name).toBe('AbortError');
    expect(alloc.mock.calls.filter(([n]) => n === 4)).toEqual([]);
  });

  it('an abort stops reading a body that cannot be destroyed, at its next chunk', async () => {
    const abort = new AbortController();
    let yielded = 0;
    const body = {
      async *[Symbol.asyncIterator]() {
        for (const c of [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3), Uint8Array.of(4)]) {
          yielded++;
          if (yielded === 2) abort.abort();
          yield c;
        }
      },
    };
    const s3 = {
      send: vi.fn(async () => ({ ContentLength: 4, Body: body })),
    } as unknown as S3Client;
    const e = await objectsOver(s3)
      .get('k', 4, abort.signal)
      .catch((x: unknown) => x);
    expect((e as Error).name).toBe('AbortError');
    expect(yielded).toBe(2);
  });

  it('an abort while the body stalls destroys it at once, and is reported as the abort', async () => {
    const abort = new AbortController();
    let stalled!: () => void;
    const body = Object.assign(
      (async function* () {
        yield Uint8Array.of(1, 2);
        await new Promise<void>((r) => (stalled = r));
        yield Uint8Array.of(3, 4);
      })(),
      { destroy: vi.fn(() => stalled?.()) }
    );
    const s3 = {
      send: vi.fn(async () => ({ ContentLength: 4, Body: body })),
    } as unknown as S3Client;
    const pending = objectsOver(s3)
      .get('k', 4, abort.signal)
      .catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    const e = await pending;
    expect(body.destroy).toHaveBeenCalled();
    expect((e as Error).name).toBe('AbortError');
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

describe("s3TagIndexObjects' default client: the snapshot bucket's own credentials", () => {
  const B2 = {
    RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT: 'http://127.0.0.1:1',
    RESOURCE_INTENT_TAG_INDEX_B2_REGION: 'us-test-777',
    RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY: 'ri-tag-index-key-id',
    RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY: 'ri-tag-index-secret',
  };
  // Values the upload client would send; none may reach the snapshot bucket.
  const UPLOAD = {
    S3_UPLOAD_BUCKET: 'uploads',
    S3_UPLOAD_ENDPOINT: 'http://127.0.0.1:2',
    S3_UPLOAD_REGION: 'us-upload-1',
    S3_UPLOAD_KEY: 'upload-key-id',
    S3_UPLOAD_SECRET: 'upload-secret',
  };
  const withEnv = (values: Record<string, unknown>) => {
    const keys = ['RESOURCE_INTENT_TAG_INDEX_BUCKET', ...Object.keys(UPLOAD), ...Object.keys(B2)];
    const before = Object.fromEntries(keys.map((k) => [k, (env as Record<string, unknown>)[k]]));
    setEnv({ RESOURCE_INTENT_TAG_INDEX_BUCKET: 'snapshots', ...UPLOAD, ...B2, ...values });
    onTestFinished(() => setEnv(before));
  };

  /** A local S3 endpoint recording each request; answers PUT 200 and GET NoSuchKey. */
  async function endpoint() {
    const requests: { method?: string; host?: string; url?: string; authorization?: string }[] = [];
    const server = createServer((req, res) => {
      requests.push({
        method: req.method,
        host: req.headers.host,
        url: req.url,
        authorization: req.headers.authorization,
      });
      req.resume();
      req.on('end', () => {
        if (req.method === 'GET') {
          res.writeHead(404, { 'content-type': 'application/xml' });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>none</Message></Error>'
          );
          return;
        }
        res.writeHead(200, { etag: '"x"' });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    // A hostname, not an IP: the SDK goes path-style on its own for an IP endpoint, which would hide
    // a client built without forcePathStyle.
    const host = `localhost:${(server.address() as AddressInfo).port}`;
    return { url: `http://${host}`, host, requests };
  }

  const KEY = `resource-intent/tag-index/${'d'.repeat(64)}`;

  it('sends to RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT, path-style, signed with its key and region', async () => {
    const ep = await endpoint();
    // The upload client points here too, so a request it signed would be seen, not refused.
    withEnv({ RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT: ep.url, S3_UPLOAD_ENDPOINT: ep.url });
    await s3TagIndexObjects().put(KEY, Buffer.from('xyz'));
    expect(ep.requests).toHaveLength(1);
    const [put] = ep.requests;
    expect(put.method).toBe('PUT');
    // Path-style: the bucket is the first path segment, not a subdomain of the endpoint.
    expect(put.host).toBe(ep.host);
    expect(put.url?.split('?')[0]).toBe(`/snapshots/${KEY}`);
    expect(put.authorization).toMatch(
      /Credential=ri-tag-index-key-id\/\d{8}\/us-test-777\/s3\/aws4_request/
    );
    expect(put.authorization).not.toContain('upload-key-id');
  });

  it('defaults the region to us-west-004 when RESOURCE_INTENT_TAG_INDEX_B2_REGION is unset', async () => {
    const ep = await endpoint();
    withEnv({
      RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT: ep.url,
      RESOURCE_INTENT_TAG_INDEX_B2_REGION: undefined,
    });
    await s3TagIndexObjects().put(KEY, Buffer.from('xyz'));
    expect(ep.requests[0].authorization).toMatch(
      /Credential=ri-tag-index-key-id\/\d{8}\/us-west-004\/s3\/aws4_request/
    );
  });

  it('reads a missing key as TagIndexObjectMissingError through the same client', async () => {
    const ep = await endpoint();
    withEnv({ RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT: ep.url });
    await expect(s3TagIndexObjects().get(KEY, 3)).rejects.toBeInstanceOf(
      TagIndexObjectMissingError
    );
    expect(ep.requests.map((r) => [r.method, r.url?.split('?')[0]])).toEqual([
      ['GET', `/snapshots/${KEY}`],
    ]);
  });

  it('refuses, naming every missing variable, and never falls back to the S3_UPLOAD_* client', () => {
    const names = [
      'RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT',
      'RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY',
      'RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY',
    ];
    withEnv(Object.fromEntries(names.map((n) => [n, undefined])));
    expect(() => s3TagIndexObjects()).toThrow(new Error(`${names.join(', ')} not set`));
    for (const name of names)
      for (const value of [undefined, '']) {
        setEnv({ ...B2, [name]: value });
        expect(() => s3TagIndexObjects()).toThrow(new Error(`${name} not set`));
      }
    // The region alone is optional.
    setEnv({ ...B2, RESOURCE_INTENT_TAG_INDEX_B2_REGION: undefined });
    expect(s3TagIndexObjects().prefix).toBe(TAG_INDEX_OBJECT_PREFIX);
  });

  it('an injected client needs none of them', () => {
    withEnv(Object.fromEntries(Object.keys(B2).map((n) => [n, undefined])));
    expect(s3TagIndexObjects({ s3: fakeS3({}).s3 }).prefix).toBe(TAG_INDEX_OBJECT_PREFIX);
  });
});

describe('s3TagIndexObjects deleting (retention)', () => {
  it('has no way to list the bucket: retention deletes only the keys its rows name', () => {
    expect(Object.keys(objectsOver(fakeS3({}).s3)).sort()).toEqual([
      'delete',
      'get',
      'prefix',
      'put',
    ]);
  });

  const HEX = 'c'.repeat(64);

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

  it.each([
    'RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT',
    'RESOURCE_INTENT_TAG_INDEX_B2_REGION',
    'RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY',
    'RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY',
  ] as const)('%s: optional, an empty value reads as unset, any other string kept', (name) => {
    const field = serverSchema.shape[name];
    expect(field.parse(undefined)).toBeUndefined();
    // An empty value must not fail the schema: it is parsed at every pod's start.
    expect(field.parse('')).toBeUndefined();
    expect(field.parse('a value')).toBe('a value');
  });
});
