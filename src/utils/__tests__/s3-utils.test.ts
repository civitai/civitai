import { describe, it, expect, vi, beforeEach } from 'vitest';

// Override the global env mock with concrete S3/B2 endpoints so module-load
// constants (s3Host, b2Host) resolve to predictable values. Any field we
// don't override falls back to the global Proxy in src/__tests__/setup.ts.
//
// `vi.mock` is hoisted, so this lands before s3-utils' module-level
// `new URL(env.S3_UPLOAD_ENDPOINT)` runs.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_BUCKET: 'civitai-modelfiles',
      S3_UPLOAD_KEY: 'test-key',
      S3_UPLOAD_SECRET: 'test-secret',
      S3_UPLOAD_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
      S3_UPLOAD_B2_ACCESS_KEY: 'b2-key',
      S3_UPLOAD_B2_SECRET_KEY: 'b2-secret',
      S3_UPLOAD_B2_BUCKET: 'civitai-modelfiles-b2',
      S3_VAULT_BUCKET: 'civitai-vault',
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return undefined;
      },
    }
  ),
}));

// vi.hoisted() runs before vi.mock() factories so we can share state with
// hoisted mocks. Without this, the mocks would reference uninitialized
// top-level constants and crash at module-load time.
const mocks = vi.hoisted(() => {
  const findManyMock = vi.fn(async () => [] as { url: string; id: number }[]);
  const deleteObjectCalls: { bucket: string; key: string }[] = [];
  const deleteManyObjectsCalls: { bucket: string; keys: string[] }[] = [];
  return { findManyMock, deleteObjectCalls, deleteManyObjectsCalls };
});

// Refcount check inside deleteModelFileObject(s) hits dbWrite.modelFile.findMany.
// Default: 0 referenced rows → all URLs are "safe to delete".
vi.mock('~/server/db/client', () => ({
  dbWrite: {
    modelFile: {
      findMany: mocks.findManyMock,
    },
  },
  dbRead: {},
}));

// Capture deleteObject / deleteManyObjects calls so we can assert which
// (bucket, key) tuples actually reach the S3 client.
// 🔴 `importOriginal` does NOT cover the interop case, which is why this file needs the same
// `default` key as the hand-listed factories: the spread copies the original's NAMED exports
// and does not synthesise a `default`. Pre-bundling wraps this CJS dep for interop, so the
// consumer resolves through `default`; without one it gets undefined, and the file collects
// almost no tests instead of going red. This file is 66 of the six files' 106 tests, so its
// count is worth asserting on its own rather than through the total.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  const mocked = {
    ...actual,
    S3Client: class {
      send = vi.fn(
        async (cmd: {
          input?: {
            Bucket?: string;
            Key?: string;
            Delete?: { Objects?: { Key?: string }[] };
          };
        }) => {
          const Bucket = cmd?.input?.Bucket ?? '';
          if (cmd?.input?.Delete?.Objects) {
            mocks.deleteManyObjectsCalls.push({
              bucket: Bucket,
              keys: cmd.input.Delete.Objects.map((o) => o.Key ?? ''),
            });
            return { Errors: [] };
          }
          mocks.deleteObjectCalls.push({ bucket: Bucket, key: cmd?.input?.Key ?? '' });
          return {};
        }
      );
    },
  };
  return { ...mocked, default: mocked };
});

import {
  parseKey,
  parseB2Url,
  deleteModelFileObject,
  deleteModelFileObjects,
  classifyS3MultipartError,
  checkFileExists,
  headObject,
  objectExists,
} from '~/utils/s3-utils';
import { env } from '~/env/server';

beforeEach(() => {
  mocks.deleteObjectCalls.length = 0;
  mocks.deleteManyObjectsCalls.length = 0;
  mocks.findManyMock.mockReset();
  mocks.findManyMock.mockResolvedValue([]);
});

describe('parseKey', () => {
  const cases: { name: string; url: string; expected: { key: string; bucket?: string } }[] = [
    {
      name: 'virtual-host-style R2 (bucket subdomain)',
      url: 'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/some/key.safetensors',
      expected: { key: 'some/key.safetensors', bucket: 'civitai-prod-settled' },
    },
    {
      name: 'path-style on configured S3 endpoint',
      url: 'https://abcd1234.r2.cloudflarestorage.com/civitai-modelfiles/path/to/key.safetensors',
      expected: { key: 'path/to/key.safetensors', bucket: 'civitai-modelfiles' },
    },
    {
      name: 'malformed URL falls through to bare-key form',
      url: 'not a url at all',
      expected: { key: 'not a url at all' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(parseKey(c.url)).toEqual(c.expected);
    });
  }
});

describe('parseB2Url', () => {
  it('parses public path-style B2 URL (s3.<region>.backblazeb2.com)', () => {
    expect(
      parseB2Url(
        'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/some/key.safetensors'
      )
    ).toEqual({ bucket: 'civitai-modelfiles-b2', key: 'some/key.safetensors' });
  });

  it('parses public virtual-host-style B2 URL', () => {
    expect(
      parseB2Url('https://civitai-modelfiles-b2.f004.backblazeb2.com/some/key.safetensors')
    ).toEqual({ bucket: 'civitai-modelfiles-b2', key: 'some/key.safetensors' });
  });

  it('parses configured B2 endpoint (matches env.S3_UPLOAD_B2_ENDPOINT host)', () => {
    expect(parseB2Url('https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/k')).toEqual({
      bucket: 'civitai-modelfiles-b2',
      key: 'k',
    });
  });

  it('returns null for malformed URLs', () => {
    expect(parseB2Url('not a url')).toBeNull();
  });

  it('returns null for non-B2 URLs', () => {
    expect(
      parseB2Url('https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/key')
    ).toBeNull();
  });

  it('returns null for path-style URL with no bucket segment', () => {
    expect(parseB2Url('https://s3.us-west-004.backblazeb2.com/')).toBeNull();
  });
});

describe('deleteModelFileObject — bucket allowlist gate', () => {
  it('deletes from an allowlisted R2 bucket', async () => {
    await deleteModelFileObject(
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/key/file.safetensors'
    );
    expect(mocks.deleteObjectCalls).toEqual([
      { bucket: 'civitai-prod-settled', key: 'key/file.safetensors' },
    ]);
  });

  it('blocks delete to a non-allowlisted R2 bucket', async () => {
    await deleteModelFileObject(
      'https://attacker-bucket.abcd1234.r2.cloudflarestorage.com/victim.bin'
    );
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });

  it('blocks delete to S3_VAULT_BUCKET (intentionally excluded from allowlist)', async () => {
    // Even though env.S3_VAULT_BUCKET is set, vault objects must be deleted
    // exclusively via vault.service.ts — never via the ModelFile cleanup path.
    await deleteModelFileObject(
      'https://civitai-vault.abcd1234.r2.cloudflarestorage.com/secret/key.bin'
    );
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });

  it('skips when refcount check finds the URL still referenced', async () => {
    mocks.findManyMock.mockResolvedValueOnce([
      { url: 'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/k', id: 7 },
    ]);
    await deleteModelFileObject('https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/k');
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });

  it('returns silently for empty url', async () => {
    await deleteModelFileObject('');
    expect(mocks.deleteObjectCalls).toHaveLength(0);
  });
});

describe('deleteModelFileObjects — bucket allowlist + grouping', () => {
  it('groups by (backend, bucket) and skips non-allowlisted buckets', async () => {
    await deleteModelFileObjects([
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/a',
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/b',
      'https://civitai-prod.abcd1234.r2.cloudflarestorage.com/c',
      'https://attacker.abcd1234.r2.cloudflarestorage.com/d',
      'https://civitai-vault.abcd1234.r2.cloudflarestorage.com/e',
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles-b2/f',
    ]);

    // Each (backend, bucket) group → one DeleteObjects call. The two
    // non-allowlisted urls (attacker, civitai-vault) must be filtered before
    // any group is built.
    const buckets = mocks.deleteManyObjectsCalls
      .map((c) => `${c.bucket}:${c.keys.sort().join(',')}`)
      .sort();
    expect(buckets).toEqual([
      'civitai-modelfiles-b2:f',
      'civitai-prod-settled:a,b',
      'civitai-prod:c',
    ]);
  });

  it('handles empty input cleanly', async () => {
    await deleteModelFileObjects([]);
    expect(mocks.deleteManyObjectsCalls).toHaveLength(0);
  });

  it('drops urls when refcount check finds them still referenced', async () => {
    mocks.findManyMock.mockResolvedValueOnce([
      { url: 'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/a', id: 1 },
    ]);
    await deleteModelFileObjects([
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/a',
      'https://civitai-prod-settled.abcd1234.r2.cloudflarestorage.com/b',
    ]);
    expect(mocks.deleteManyObjectsCalls).toEqual([{ bucket: 'civitai-prod-settled', keys: ['b'] }]);
  });
});

// The classifier that de-fangs the multipart complete/abort raw-500 landmine
// (~27 raw-500s/12h on dp-prod). Pure function → exercised directly here; the
// handler-level mapping (409 vs 204 vs 503 vs 500) is covered in
// src/server/__tests__/upload-{complete,abort}-endpoint.test.ts.
describe('classifyS3MultipartError', () => {
  it('classifies AWS-SDK NoSuchUpload (name + $metadata 404) as not-found', () => {
    const err = Object.assign(
      new Error(
        'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.'
      ),
      { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } }
    );
    expect(classifyS3MultipartError(err)).toBe('not-found');
  });

  it('classifies a bare 404 (no name) as not-found', () => {
    const err = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
    expect(classifyS3MultipartError(err)).toBe('not-found');
  });

  it.each([500, 502, 503, 504])('classifies an S3 HTTP %i as transient', (status) => {
    const err = Object.assign(new Error('storage blip'), {
      name: 'InternalError',
      $metadata: { httpStatusCode: status },
    });
    expect(classifyS3MultipartError(err)).toBe('transient');
  });

  it.each(['SlowDown', 'RequestTimeout', 'RequestTimeTooSkewed', 'ServiceUnavailable'])(
    'classifies the throttle/timing signal %s as transient',
    (name) => {
      // No httpStatusCode → matched purely by name.
      const err = Object.assign(new Error(name), { name });
      expect(classifyS3MultipartError(err)).toBe('transient');
    }
  );

  it('classifies a status-less network failure (ECONNRESET) as transient', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyS3MultipartError(err)).toBe('transient');
  });

  it('classifies a status-less ETIMEDOUT as transient', () => {
    const err = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
    expect(classifyS3MultipartError(err)).toBe('transient');
  });

  it.each(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'MalformedXML'])(
    'classifies the parts-manifest fault %s (400) as invalid-parts',
    (name) => {
      const err = Object.assign(new Error('parts mismatch'), {
        name,
        $metadata: { httpStatusCode: 400 },
      });
      expect(classifyS3MultipartError(err)).toBe('invalid-parts');
    }
  );

  it('classifies InvalidPart by name even without a status code as invalid-parts', () => {
    // The dominant dp-prod signature carries $metadata 400, but the name alone is
    // an unambiguous parts fault.
    const err = Object.assign(
      new Error(
        "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag."
      ),
      { name: 'InvalidPart' }
    );
    expect(classifyS3MultipartError(err)).toBe('invalid-parts');
  });

  it('classifies InvalidRequest + 400 ("must specify at least one part") as invalid-parts', () => {
    const err = Object.assign(new Error('You must specify at least one part'), {
      name: 'InvalidRequest',
      $metadata: { httpStatusCode: 400 },
    });
    expect(classifyS3MultipartError(err)).toBe('invalid-parts');
  });

  it('classifies a generic/unknown error as other (stays a hard 500)', () => {
    expect(classifyS3MultipartError(new Error('boom'))).toBe('other');
  });

  it('does NOT over-broaden: an unknown 4xx name (400) still classifies as other', () => {
    // Guard against the client-fault bucket swallowing genuine unrecognized 400s —
    // only the named parts-manifest faults (+ InvalidRequest/400) are invalid-parts.
    const err = Object.assign(new Error('bad request'), {
      name: 'SomeUnknownClientError',
      $metadata: { httpStatusCode: 400 },
    });
    expect(classifyS3MultipartError(err)).toBe('other');
  });

  it('does NOT map InvalidRequest without a 400 (e.g. no status) as invalid-parts', () => {
    // InvalidRequest is a generic name; only a 400 on this path is a parts fault.
    const err = Object.assign(new Error('generic invalid request'), { name: 'InvalidRequest' });
    expect(classifyS3MultipartError(err)).toBe('other');
  });

  it('handles null / undefined without throwing', () => {
    expect(classifyS3MultipartError(null)).toBe('other');
    expect(classifyS3MultipartError(undefined)).toBe('other');
  });
});

describe('checkFileExists — SDK error shape → tri-state mapping', () => {
  // 🔴 This mapping is load-bearing for the cover-image guard, which REJECTS a user's save on
  // `false`. Every rejection shape the AWS SDK can hand back has to land on the right side of
  // that line: only a definitive "the bucket says this key is not there" may be `false`.
  // Everything else — throttling, auth, transport, an abort — is `null`, i.e. "we do not know",
  // and the caller proceeds. Reasoning about this from the source is not the same as running it.
  function s3Throwing(error: unknown) {
    return { send: vi.fn().mockRejectedValue(error) } as never;
  }

  const key = '0d5f0a4e-0000-4000-8000-000000000001';

  it('returns true when HeadObject succeeds', async () => {
    const s3 = { send: vi.fn().mockResolvedValue({}) } as never;
    await expect(checkFileExists(key, { s3, bucket: 'uploads-bucket' })).resolves.toBe(true);
  });

  it.each([
    ['NotFound', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }],
    ['NoSuchKey', { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }],
    // A 404 whose name the SDK did not map — still definitively absent.
    ['a bare 404', { name: 'UnrecognizedClientError', $metadata: { httpStatusCode: 404 } }],
  ])('maps %s to false (definitively absent)', async (_label, error) => {
    await expect(
      checkFileExists(key, { s3: s3Throwing(error), bucket: 'uploads-bucket' })
    ).resolves.toBe(false);
  });

  it.each([
    // 🔴 The throttle case the cover-image audit could only verify by inspection. A backend
    // shedding load must never read as "the user's upload is gone".
    ['a 503 SlowDown throttle', { name: 'SlowDown', $metadata: { httpStatusCode: 503 } }],
    [
      'a 403 from a rotated/insufficient key',
      { name: 'Forbidden', $metadata: { httpStatusCode: 403 } },
    ],
    ['a 500 from the backend', { name: 'InternalError', $metadata: { httpStatusCode: 500 } }],
    // No `$metadata` at all: the request never got an HTTP answer.
    [
      'a transport error with no status',
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ],
    // What `AbortSignal.timeout` surfaces as through the node HTTP handler — the timeout
    // budget must fail OPEN, not reject the save.
    ['an aborted request', Object.assign(new Error('Request aborted'), { name: 'AbortError' })],
  ])('maps %s to null (unknown — caller fails open)', async (_label, error) => {
    await expect(
      checkFileExists(key, { s3: s3Throwing(error), bucket: 'uploads-bucket' })
    ).resolves.toBeNull();
  });

  it('forwards an abort signal to the SDK send call', async () => {
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    const abortSignal = AbortSignal.timeout(5_000);

    await checkFileExists(key, { s3: s3 as never, bucket: 'uploads-bucket', abortSignal });

    expect(s3.send).toHaveBeenCalledTimes(1);
    // Second arg is the SDK's per-call HttpHandlerOptions — the only place a caller can bound
    // a request that otherwise inherits default retries and no timeout.
    expect(s3.send.mock.calls[0][1]).toEqual({ abortSignal });
  });
});

describe('headObject — presence AND size, as a three-state result', () => {
  // 🔴 This mapping guards /api/upload/complete, which can REJECT a finished upload on
  // `absent`. Only a definitive "the bucket says this key is not there" may be `absent`;
  // every other rejection shape — throttle, auth, transport, abort — is `unknown`, i.e.
  // "we could not consult the bucket", and the caller passes the request through.
  const s3Throwing = (error: unknown) => ({ send: vi.fn().mockRejectedValue(error) } as never);
  const s3Returning = (out: unknown) => ({ send: vi.fn().mockResolvedValue(out) } as never);

  const BUCKET = 'test-bucket';
  const KEY = 'model/1/x.safetensors';

  it('returns the ContentLength the backend reported', async () => {
    await expect(headObject(BUCKET, KEY, s3Returning({ ContentLength: 4096 }))).resolves.toEqual({
      status: 'present',
      size: 4096,
    });
  });

  it('reports a real ZERO length as zero, not as "no length"', async () => {
    await expect(headObject(BUCKET, KEY, s3Returning({ ContentLength: 0 }))).resolves.toEqual({
      status: 'present',
      size: 0,
    });
  });

  // 🔴 `size: null` is "the backend reported no length", NOT zero. A caller that treats
  // it as zero rejects healthy uploads on any backend that omits ContentLength.
  it.each([
    ['an omitted ContentLength', {}],
    ['a non-numeric ContentLength', { ContentLength: '4096' }],
  ])('maps %s to size null while still present', async (_label, out) => {
    await expect(headObject(BUCKET, KEY, s3Returning(out))).resolves.toEqual({
      status: 'present',
      size: null,
    });
  });

  it.each([
    ['NotFound', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }],
    ['NoSuchKey', { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }],
    ['a bare 404', { name: 'UnrecognizedClientError', $metadata: { httpStatusCode: 404 } }],
  ])('maps %s to absent (definitively not there)', async (_label, error) => {
    await expect(headObject(BUCKET, KEY, s3Throwing(error))).resolves.toEqual({
      status: 'absent',
    });
  });

  it.each([
    ['a 503 SlowDown throttle', { name: 'SlowDown', $metadata: { httpStatusCode: 503 } }],
    ['a 403 from a rotated key', { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }],
    ['a 500 from the backend', { name: 'InternalError', $metadata: { httpStatusCode: 500 } }],
    ['a transport error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['an aborted request', Object.assign(new Error('Request aborted'), { name: 'AbortError' })],
  ])('maps %s to unknown (caller fails open)', async (_label, error) => {
    await expect(headObject(BUCKET, KEY, s3Throwing(error))).resolves.toEqual({
      status: 'unknown',
    });
  });

  // 🔴 The bound is the only thing stopping this probe from hanging a finished upload
  // against a degraded backend: the client has SDK-default retries and no request
  // timeout. Asserting the signal REACHES the send is what makes removing it fail —
  // injecting an AbortError instead only proves the error mapping.
  it('forwards an abort signal to the SDK send call', async () => {
    const s3 = { send: vi.fn().mockResolvedValue({ ContentLength: 1 }) };
    const abortSignal = AbortSignal.timeout(5_000);

    await headObject(BUCKET, KEY, s3 as never, { abortSignal });

    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(s3.send.mock.calls[0][1]).toEqual({ abortSignal });
  });

  /**
   * 🔴 STRUCTURAL, not spelled. The handler's fail-open rests on `headObject` never
   * throwing, and the case that actually threw before was CLIENT RESOLUTION — an
   * unconfigured environment makes `getS3Client()` throw. Passing a client object can
   * never reach that line, so a test that does so passes with the resolution back
   * outside the try. This strips a required env var and passes no client, which is the
   * only shape that exercises it.
   */
  it('resolves to unknown when the client cannot be constructed at all', async () => {
    const envRecord = env as unknown as Record<string, unknown>;
    const saved = envRecord.S3_UPLOAD_KEY;
    delete envRecord.S3_UPLOAD_KEY;
    try {
      await expect(headObject(BUCKET, KEY, null)).resolves.toEqual({ status: 'unknown' });
    } finally {
      envRecord.S3_UPLOAD_KEY = saved;
    }
  });
});

describe('objectExists — the boolean view of headObject keeps its tri-state', () => {
  // 🔴 `null` (couldn't consult the bucket) must stay distinct from `false` (definitely
  // absent). Collapsing them makes /api/upload/complete report a terminal 409 for an
  // infrastructure hiccup, stranding bytes with no DB row — the exact failure the
  // not-found branch was written to avoid.
  it.each([
    ['a successful head', 'true', { ContentLength: 1 }, null, true],
    [
      'a definitive 404',
      'false',
      null,
      { name: 'NotFound', $metadata: { httpStatusCode: 404 } },
      false,
    ],
    [
      'a 403 that cannot answer',
      'null',
      null,
      { name: 'Forbidden', $metadata: { httpStatusCode: 403 } },
      null,
    ],
  ])('maps %s to %s', async (_label, _expectedLabel, resolved, rejected, expected) => {
    const s3 = {
      send: rejected ? vi.fn().mockRejectedValue(rejected) : vi.fn().mockResolvedValue(resolved),
    } as never;
    await expect(objectExists('test-bucket', 'k', s3)).resolves.toBe(expected);
  });
});
