import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as S3Utils from '~/utils/s3-utils';

/**
 * `headStoredImage` — the entity-tag re-read the listing attach gate depends on.
 *
 * The property under test is that it is BOUNDED. Its three-state result already
 * fails open on an error, and that is the state everything downstream reasons
 * about; what an error-shaped test cannot show is the other way a store fails,
 * which is by not answering at all. An unbounded head does not fail open — it
 * holds the caller open — and because a healthy backend answers with or without a
 * timeout, nothing about a missing bound is observable until production is the
 * thing that is degraded.
 */

const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }));

// Nothing here talks to the database, but the module graph reaches a Prisma client
// that cannot initialise in a unit environment — and it fails as an UNHANDLED
// REJECTION, i.e. a red run with every test green. Stubbed so the run's verdict is
// about this module.
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
  dbKV: {},
}));

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
