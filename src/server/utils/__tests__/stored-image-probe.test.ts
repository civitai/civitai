import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as S3Utils from '~/utils/s3-utils';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `headStoredImage` and `probeStoredImage` — the two requests this module makes
 * against the image store, BOTH of them inline on a user-facing mutation.
 *
 * The property under test is that they are BOUNDED. Their failure handling already
 * covers a store that ERRORS, and that is the state everything downstream reasons
 * about; what an error-shaped test cannot show is the other way a store fails,
 * which is by not answering at all. An unbounded request does not fail open — it
 * holds the caller open — and because a healthy backend answers with or without a
 * timeout, nothing about a missing bound is observable until production is the
 * thing that is degraded.
 */

const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mockS3Send },
    bucket: 'test-image-bucket',
    backend: 'backblaze' as const,
  }),
}));

const KEY = '44444444-4444-4444-8444-444444444444';

/** A store that never answers — it settles only when the caller gives up on it. */
function hangUntilAborted() {
  return (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = options?.abortSignal;
      if (!signal) return; // no bound handed down → hangs forever, which is the bug
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
      );
    });
}

/**
 * A store that ANSWERS and then stops mid-body — headers back, bytes never
 * arriving. A distinct failure from "no response at all", and the one a ranged GET
 * is actually exposed to, since it is the only request here that transfers bytes.
 *
 * The abort is wired into the body read as well as the response, which is what the
 * AWS SDK really does: the signal destroys the underlying request, so a stream still
 * being read off that socket errors rather than idling forever.
 */
function answerThenStallBody() {
  return async (_command: unknown, options?: { abortSignal?: AbortSignal }) => ({
    ContentRange: 'bytes 0-15/16',
    ETag: '"abc123"',
    Body: {
      transformToByteArray: () =>
        new Promise((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) return; // unbounded → the read never ends, which is the bug
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
          );
        }),
    },
  });
}

/** Real, decodable bytes, so a happy-path probe is not a fixture-shaped assertion. */
async function flatPng() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 1, b: 1 } } })
    .png()
    .toBuffer();
}

/**
 * Every hang case below must settle in MILLISECONDS — the injected budget is the
 * thing under test. The suite-wide 60s ceiling would let a regression cost a minute
 * per case before reporting, so bound them explicitly.
 */
const HANG_CASE_TIMEOUT_MS = 10_000;

beforeEach(() => {
  mockS3Send.mockReset();
});

describe('headStoredImage', () => {
  it('reads back the entity tag the store reports', async () => {
    mockS3Send.mockResolvedValue({ ETag: '"abc123"' });
    const { headStoredImage } = await import('~/server/utils/stored-image-probe');

    await expect(headStoredImage(KEY)).resolves.toEqual({ status: 'present', etag: '"abc123"' });
    // POSITIVE CONTROL: the assertions below are about a call that really happens.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('bounds the request with an abort signal derived from the timeout budget', async () => {
    mockS3Send.mockResolvedValue({ ETag: '"abc123"' });
    const { headStoredImage, STORED_IMAGE_HEAD_TIMEOUT_MS } = await import(
      '~/server/utils/stored-image-probe'
    );

    await headStoredImage(KEY);

    const signal = (mockS3Send.mock.calls[0][1] as { abortSignal?: AbortSignal })?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    // The budget is a real, finite, non-zero one: a 0 would abort every head before
    // it left, and an Infinity would be the unbounded case wearing a signal.
    expect(STORED_IMAGE_HEAD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(STORED_IMAGE_HEAD_TIMEOUT_MS)).toBe(true);
  });

  /**
   * 🔴 THE POINT. A store that hangs must resolve to `unknown` — the same "we could
   * not consult it" the caller already fails open on — and must NOT reject, because
   * a rejection out of here would propagate as a 500 from an attach whose image is
   * perfectly fine.
   */
  it('resolves UNKNOWN (never rejects) when the store does not answer in time', async () => {
    mockS3Send.mockImplementation(hangUntilAborted());
    const { headStoredImage } = await import('~/server/utils/stored-image-probe');

    await expect(headStoredImage(KEY, { timeoutMs: 5 })).resolves.toEqual({ status: 'unknown' });
  });

  /**
   * And the verdict a hung store produces at the consumer's end is `unverifiable`,
   * i.e. the attach proceeds. Composed here rather than asserted in two places, so
   * a change that made a timeout look like a MISMATCH — a rejected upload for a
   * slow bucket — cannot pass both halves separately.
   */
  it('a timed-out head classifies as unverifiable, not as tampering', async () => {
    mockS3Send.mockImplementation(hangUntilAborted());
    const { headStoredImage } = await import('~/server/utils/stored-image-probe');
    const { classifyStoredObjectIntegrity } = await import(
      '~/server/services/blocks/stored-object-integrity'
    );

    const head = await headStoredImage(KEY, { timeoutMs: 5 });
    expect(classifyStoredObjectIntegrity('"abc123"', head)).toEqual({
      status: 'unverifiable',
      reason: 'store-unreachable',
    });
  });

  it('still distinguishes an ANSWERED miss from a store that could not be consulted', async () => {
    const { headStoredImage } = await import('~/server/utils/stored-image-probe');

    mockS3Send.mockRejectedValue(
      Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      })
    );
    await expect(headStoredImage(KEY)).resolves.toEqual({ status: 'absent' });

    mockS3Send.mockRejectedValue(
      Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } })
    );
    await expect(headStoredImage(KEY)).resolves.toEqual({ status: 'unknown' });
  });

  it('reports no tag as null rather than inventing one', async () => {
    const { headStoredImage } = await import('~/server/utils/stored-image-probe');

    mockS3Send.mockResolvedValue({ ContentLength: 10 });
    await expect(headStoredImage(KEY)).resolves.toEqual({ status: 'present', etag: null });
  });
});

/**
 * 🔴 THE INJECTED BUDGET HAS TO BE THE ONE THAT IS USED.
 *
 * `timeoutMs` exists so the abort path is reachable in milliseconds instead of
 * seconds. Nothing else observes it: a version that accepts the parameter and then
 * bounds every request with the module constant behaves IDENTICALLY in production
 * and passes every hang case above — they would simply take five seconds each
 * instead of five milliseconds, which no assertion reads. So the value handed to the
 * bound is asserted directly.
 *
 * Asserted through a spy on `AbortSignal.timeout` rather than by timing the call:
 * a wall-clock assertion would pin the same property with a race attached, and a
 * flaky guard is one that gets re-run rather than believed.
 */
describe('the timeout budget that is applied is the one the caller passed', () => {
  it.each([
    {
      what: 'headStoredImage',
      call: async (opts?: { timeoutMs?: number }) => {
        const { headStoredImage } = await import('~/server/utils/stored-image-probe');
        mockS3Send.mockResolvedValue({ ETag: '"abc123"' });
        await headStoredImage(KEY, opts);
      },
      constant: 'STORED_IMAGE_HEAD_TIMEOUT_MS' as const,
    },
    {
      what: 'probeStoredImage',
      call: async (opts?: { timeoutMs?: number }) => {
        const { probeStoredImage } = await import('~/server/utils/stored-image-probe');
        const bytes = await flatPng();
        mockS3Send.mockResolvedValue({
          Body: { transformToByteArray: async () => new Uint8Array(bytes) },
          ContentRange: `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
          ETag: '"abc123"',
        });
        await probeStoredImage(KEY, { maxBytes: 1024 * 1024, ...opts });
      },
      constant: 'STORED_IMAGE_READ_TIMEOUT_MS' as const,
    },
  ])('$what', async ({ call, constant }) => {
    const probeModule = await import('~/server/utils/stored-image-probe');
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      // A value that is not the constant and not any other number in this module,
      // so "the parameter was read" and "a default was applied" cannot look alike.
      await call({ timeoutMs: 37 });
      await call();

      expect(spy.mock.calls.map(([ms]) => ms)).toEqual([37, probeModule[constant]]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * `probeStoredImage` — the RANGED READ, and the request that actually transfers
 * bytes.
 *
 * It sits on the same user-facing mutation as the head above (the listing persist
 * proc, via `measureUploadedImage`), so the same argument applies to it and applies
 * harder: a head exchanges a round trip, this streams up to `maxBytes + 1` off the
 * socket, so there are two ways for it to stall rather than one.
 */
describe('probeStoredImage is bounded too', () => {
  it('hands the ranged read an abort signal that has not already fired', async () => {
    const bytes = await flatPng();
    mockS3Send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array(bytes) },
      ContentRange: `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      ETag: '"abc123"',
    });
    const { probeStoredImage, STORED_IMAGE_READ_TIMEOUT_MS } = await import(
      '~/server/utils/stored-image-probe'
    );

    await expect(probeStoredImage(KEY, { maxBytes: 1024 * 1024 })).resolves.toMatchObject({
      width: 8,
      height: 8,
      format: 'png',
    });

    // POSITIVE CONTROL: the assertions below are about a request that really happened.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    const signal = (mockS3Send.mock.calls[0][1] as { abortSignal?: AbortSignal })?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // An expired budget would abort every read before it left, turning every upload
    // into "we could not read that back" — the failure a bare "a signal was passed"
    // assertion waves through.
    expect(signal?.aborted).toBe(false);
    expect(STORED_IMAGE_READ_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(STORED_IMAGE_READ_TIMEOUT_MS)).toBe(true);
  });

  /**
   * 🔴 THE POINT, first shape: no response at all. Unbounded, this call never
   * returns and the persist mutation holding it never returns either.
   */
  it(
    'fails as store-unavailable (rather than hanging) when the store never responds',
    async () => {
      mockS3Send.mockImplementation(hangUntilAborted());
      const { probeStoredImage, StoredImageProbeError } = await import(
        '~/server/utils/stored-image-probe'
      );

      const err = await probeStoredImage(KEY, { maxBytes: 1024 * 1024, timeoutMs: 5 }).catch(
        (e) => e
      );

      expect(err).toBeInstanceOf(StoredImageProbeError);
      // The classification matters as much as the bound: an aborted read is "we could
      // not consult the store", which is the caller's retryable branch — NOT `missing`
      // or `unreadable`, both of which tell the uploader their file is at fault.
      expect(err).toMatchObject({ reason: 'store-unavailable' });
    },
    HANG_CASE_TIMEOUT_MS
  );

  /**
   * 🔴 THE POINT, second shape, and the one only a byte-transferring request has:
   * headers arrive and the body then stalls. A bound applied to the response alone
   * would leave this case unbounded while the case above passes.
   */
  it(
    'fails as store-unavailable when the response arrives but the bytes never do',
    async () => {
      mockS3Send.mockImplementation(answerThenStallBody());
      const { probeStoredImage, StoredImageProbeError } = await import(
        '~/server/utils/stored-image-probe'
      );

      const err = await probeStoredImage(KEY, { maxBytes: 1024 * 1024, timeoutMs: 5 }).catch(
        (e) => e
      );

      expect(err).toBeInstanceOf(StoredImageProbeError);
      expect(err).toMatchObject({ reason: 'store-unavailable' });
    },
    HANG_CASE_TIMEOUT_MS
  );
});
