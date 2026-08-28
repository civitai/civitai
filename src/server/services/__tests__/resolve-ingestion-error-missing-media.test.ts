import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE } from '@civitai/shared';
import type * as S3Utils from '~/utils/s3-utils';
import type * as Shared from '@civitai/shared';

/**
 * The main-app half of the missing-media publish guard.
 *
 * `resolveIngestionError` here is the copy the article-image-scan flow reuses, and it published an
 * image — `ingestion = 'Scanned'` plus a locked nsfwLevel — without ever asking whether the media
 * exists. The spoke's copy is guarded in its own suite; this one proves the same rule runs in this
 * runtime, and that it runs THROUGH the shared module rather than a second local copy of it.
 */

const { headObject, getB2ImageS3Client, assertSpy } = vi.hoisted(() => ({
  headObject: vi.fn(),
  getB2ImageS3Client: vi.fn(() => ({} as never)),
  assertSpy: vi.fn(),
}));

// Narrow overrides on a spread of the real module — s3-utils exports a great many things this
// service uses, and a one-key factory would take the whole file out at collection.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  headObject,
  getB2ImageS3Client,
}));

/**
 * The wiring probe. `assertMediaPresentForPublish` still runs for real — this only records that the
 * service reached the SHARED implementation. A shared function nobody calls is worse than none, and
 * a local re-implementation would pass every behavioural case below while silently drifting.
 */
vi.mock('@civitai/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return {
    ...actual,
    assertMediaPresentForPublish: (
      ...args: Parameters<typeof actual.assertMediaPresentForPublish>
    ) => {
      assertSpy(...args);
      return actual.assertMediaPresentForPublish(...args);
    },
  };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resolveIngestionError } from '~/server/services/image.service';

const IMAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const resolve = () => resolveIngestionError({ id: 4242, nsfwLevel: 1, userId: 7 });

beforeEach(() => {
  vi.clearAllMocks();
  // postId null keeps the post-level recompute out of the way; it is not what these cases pin.
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    ingestion: 'Error',
    postId: null,
    userId: 99,
    metadata: {},
    url: IMAGE_KEY,
  } as never);
});

describe('main-app resolveIngestionError — missing-media guard', () => {
  it('REFUSES to publish when the bucket answered that the object is absent', async () => {
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow(MISSING_MEDIA_PUBLISH_MESSAGE);

    // The write is the harm. Before this guard it ran unconditionally.
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('surfaces the refusal as a BAD_REQUEST, so a moderator sees the message not a 500', async () => {
    headObject.mockResolvedValue({ status: 'absent' });
    await expect(resolve()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('probes the image row url in the uploads bucket, under a bounded signal', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 12345 });

    await resolve();

    expect(headObject).toHaveBeenCalledTimes(1);
    const [bucket, key, , options] = headObject.mock.calls[0];
    expect(bucket).toBe('civitai-media-uploads');
    expect(key).toBe(IMAGE_KEY);
    // An unbounded probe against a degraded backend turns a moderator's click into a hung request.
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('publishes exactly as before when the bucket confirms the object is present', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 12345 });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    const arg = dbMock.dbWrite.image.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: 4242 });
    // Literal expectations rather than a re-read of the implementation.
    expect(arg.data).toMatchObject({
      nsfwLevel: 1,
      nsfwLevelLocked: true,
      ingestion: 'Scanned',
    });
  });

  it('publishes when the bucket could not be consulted (probe returned unknown)', async () => {
    headObject.mockResolvedValue({ status: 'unknown' });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('publishes when the storage CLIENT cannot even be built', async () => {
    // `getB2ImageS3Client()` throws when credentials are absent. That must land on "could not
    // consult", not on a failed publish — a guard that can fail the path by its own absence is
    // worse than no guard. The client is resolved inside the probe for exactly this reason.
    getB2ImageS3Client.mockImplementation(() => {
      throw new Error('B2 image upload credentials not configured');
    });

    await resolve();

    expect(headObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('decides through the SHARED module, not a second local copy of the rule', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 1 });
    await resolve();
    expect(assertSpy).toHaveBeenCalledTimes(1);
  });

  it('still refuses before the probe when there is no such image', async () => {
    // Reachability control: the not-found check runs FIRST, so a fixture without a row would test
    // that check instead of this guard.
    dbMock.dbRead.image.findUnique.mockResolvedValue(null as never);
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow('Image not found');
    expect(headObject).not.toHaveBeenCalled();
  });
});
