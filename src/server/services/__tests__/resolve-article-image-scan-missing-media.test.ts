import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE } from '@civitai/shared';
import type * as S3Utils from '~/utils/s3-utils';
import type * as SearchIndex from '~/server/search-index';

/**
 * The second main-app entry point into `resolveIngestionError`: a moderator resolving an ARTICLE's
 * image scan. Article images are ordinary `Image` rows in the same media store, so the guard is
 * correct for them — but "correct" is a claim about a path, and this path was never exercised by
 * the guard's own suite.
 *
 * The case worth pinning is the ORDER: a refused publish must leave the article untouched, rather
 * than recompute its ingestion and re-index it around a write that never happened.
 */

const { headObject } = vi.hoisted(() => ({ headObject: vi.fn() }));

/**
 * 🔴 `getImageUploadBackend` is mocked, not just `getB2ImageS3Client`, and the distinction is the
 * whole reason this file went red once. The probe resolves its bucket + client through
 * `getImageUploadBackend()` (so it cannot drift from the store the upload path wrote to); the REAL
 * one — which `importOriginal` hands back — calls s3-utils' own internal client factory, not the
 * mocked export, and that factory throws with no credentials. The probe then landed on `unknown`,
 * the publish was ALLOWED, and the refusal case failed with "promise resolved undefined".
 */
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  headObject,
  getB2ImageS3Client: () => ({} as never),
  getImageUploadBackend: async () => ({
    s3: {} as never,
    bucket: 'civitai-media-uploads',
    backend: 'backblaze' as const,
  }),
}));

const { queueUpdate } = vi.hoisted(() => ({ queueUpdate: vi.fn() }));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  articlesSearchIndex: { queueUpdate },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resolveArticleImageScan } from '~/server/services/article.service';

const IMAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const resolve = () =>
  resolveArticleImageScan({ articleId: 11, imageId: 4242, nsfwLevel: 1, userId: 7 });

beforeEach(() => {
  vi.clearAllMocks();
  // The image IS this article's cover, so the cross-article guard above lets it through — otherwise
  // the case below would be testing that check instead of the media guard.
  dbMock.dbRead.article.findUnique.mockResolvedValue({ coverId: 4242 } as never);
  dbMock.dbRead.imageConnection.findFirst.mockResolvedValue({ imageId: 4242 } as never);
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    ingestion: 'Error',
    postId: null,
    userId: 99,
    metadata: {},
    url: IMAGE_KEY,
  } as never);
  // Enough of an article for the post-resolve recompute to run; its outcome is not what is pinned
  // here, only that it runs on the allow paths and does not on the refuse path.
  dbMock.dbWrite.article.findUniqueOrThrow.mockResolvedValue({
    ingestion: 'Pending',
    status: 'Draft',
    publishedAt: null,
    userId: 99,
    title: 'a',
    content: 'b',
    coverId: null,
    moderatorNsfwLevel: null,
  } as never);
});

describe('resolveArticleImageScan — inherits the missing-media guard', () => {
  it('refuses, and leaves the article completely untouched', async () => {
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow(MISSING_MEDIA_PUBLISH_MESSAGE);

    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    // The two follow-on effects sit AFTER the resolve call, so a guard that threw late — or one
    // wired after them — would still have recomputed and re-indexed the article.
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('still resolves an article image whose media is present', async () => {
    headObject.mockResolvedValue({ status: 'present', size: 12345 });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    // The allow path re-indexes; the refuse path above must not. (The recompute queues one of its
    // own, so the count is >1 here — the contrast that matters is against the zero above.)
    expect(queueUpdate.mock.calls.length).toBeGreaterThan(0);
  });

  it('still resolves when the store could not be consulted', async () => {
    headObject.mockResolvedValue({ status: 'unknown' });

    await resolve();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-article image before ever probing the store', async () => {
    // Reachability control for the ordering claim: this earlier check owns its own case.
    dbMock.dbRead.article.findUnique.mockResolvedValue({ coverId: 999 } as never);
    dbMock.dbRead.imageConnection.findFirst.mockResolvedValue(null as never);
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(resolve()).rejects.toThrow('does not belong to article');
    expect(headObject).not.toHaveBeenCalled();
  });
});
