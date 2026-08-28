import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';

import {
  isProbeableMediaKey,
  probeCreatedImageMedia,
  type CreatedImageMediaProbeDeps,
} from '~/server/utils/created-image-media-probe';
import { headObject } from '~/utils/s3-utils';

/**
 * The media-existence probe behind `createImage`.
 *
 * 🔴 These drive the REAL `headObject` (and therefore the real not-found classifier)
 * over a stubbed S3 `send`, rather than faking `headObject` itself. A fake could
 * encode the same wrong shape as the code and pass with the bug present; an
 * AWS-SDK-shaped rejection cannot.
 *
 * Every expected verdict below is a hand-written literal, not something recomputed
 * from the implementation.
 */

const BUCKET = 'test-media-bucket';
const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Build the deps with a `send` that answers however the case needs. */
function depsWithSend(send: (command: unknown) => unknown): CreatedImageMediaProbeDeps {
  return {
    getBackend: async () => ({
      s3: { send: vi.fn(send) } as unknown as Awaited<
        ReturnType<CreatedImageMediaProbeDeps['getBackend']>
      >['s3'],
      bucket: BUCKET,
    }),
    headObject,
  };
}

/** The shape the AWS SDK throws for a key that is not there. */
function notFoundError() {
  return Object.assign(new Error('NotFound'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

describe('isProbeableMediaKey', () => {
  it('accepts a bare media key (the uuid an upload endpoint issues)', () => {
    expect(isProbeableMediaKey('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true);
  });

  it.each([
    'https://example.com/some/image.png',
    'http://example.com/some/image.png',
    'https://image.civitai.com/xyz/width=450/thing.jpeg',
    '',
    'not-a-uuid',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/extra',
    '  aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee  ',
  ])('rejects %j — not a key this store can be asked about', (value) => {
    expect(isProbeableMediaKey(value)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])('rejects the non-string %j', (value) => {
    expect(isProbeableMediaKey(value)).toBe(false);
  });
});

describe('probeCreatedImageMedia — three verdicts, never a boolean', () => {
  it('returns `present` when the bucket answers with a non-empty object', async () => {
    const verdict = await probeCreatedImageMedia(
      KEY,
      depsWithSend(async () => ({ ContentLength: 12_345 }))
    );
    expect(verdict).toBe('present');
  });

  it('returns `absent` when the bucket ANSWERS that the key is not there', async () => {
    const verdict = await probeCreatedImageMedia(
      KEY,
      depsWithSend(async () => {
        throw notFoundError();
      })
    );
    expect(verdict).toBe('absent');
  });

  it('returns `absent` for a definitively ZERO-length object', async () => {
    // A stored but empty object is the same defect from the reader's point of view.
    const verdict = await probeCreatedImageMedia(
      KEY,
      depsWithSend(async () => ({ ContentLength: 0 }))
    );
    expect(verdict).toBe('absent');
  });

  it('returns `present` when the backend reports NO length — `null` is not zero', async () => {
    // 🔴 The distinction the size check must not collapse: "the backend did not report
    // a length" is not "the object has no bytes". Treating it as zero would reject
    // healthy rows on any backend that omits ContentLength.
    const verdict = await probeCreatedImageMedia(
      KEY,
      depsWithSend(async () => ({}))
    );
    expect(verdict).toBe('present');
  });

  it('returns `unknown` when the bucket cannot be consulted — a 403, not a 404', async () => {
    const verdict = await probeCreatedImageMedia(
      KEY,
      depsWithSend(async () => {
        throw Object.assign(new Error('Forbidden'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
      })
    );
    expect(verdict).toBe('unknown');
  });

  it('returns `unknown` when resolving the storage backend throws (unconfigured env)', async () => {
    // 🔴 A probe that GUARDS a working code path must not be able to fail that path by
    // its own absence.
    const verdict = await probeCreatedImageMedia(KEY, {
      getBackend: async () => {
        throw new Error('Next S3 Upload: Missing ENVs S3_UPLOAD_KEY');
      },
      headObject,
    });
    expect(verdict).toBe('unknown');
  });

  it('returns `unknown` on an abort (the timeout budget), never `absent`', async () => {
    const verdict = await probeCreatedImageMedia(
      KEY,
      depsWithSend(async () => {
        throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
      })
    );
    expect(verdict).toBe('unknown');
  });

  it('returns `not-applicable` for a full http(s) url, and never touches the bucket', async () => {
    // `addPostImageSchema` permits `z.url().or(z.string().uuid())`, and legacy avatar
    // rows hold a full external URL. HEADing one of those against OUR bucket asks a
    // nonsensical question and would answer `absent` for a perfectly good row.
    const send = vi.fn(async () => ({ ContentLength: 1 }));
    const verdict = await probeCreatedImageMedia('https://example.com/avatar.png', {
      getBackend: async () => ({
        s3: { send } as never,
        bucket: BUCKET,
      }),
      headObject,
    });
    expect(verdict).toBe('not-applicable');
    expect(send).not.toHaveBeenCalled();
  });

  it('asks for the key it was given, in the bucket the backend resolved', async () => {
    const send = vi.fn(async () => ({ ContentLength: 1 }));
    await probeCreatedImageMedia(KEY, {
      getBackend: async () => ({ s3: { send } as never, bucket: BUCKET }),
      headObject,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as unknown as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({ Bucket: BUCKET, Key: KEY });
  });
});
