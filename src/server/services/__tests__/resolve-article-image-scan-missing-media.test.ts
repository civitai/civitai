import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_MEDIA_PUBLISH_MESSAGE } from '@civitai/shared';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * The SECOND caller of `resolveIngestionError`, and the one no case in this PR's other suites
 * touches.
 *
 * 🔴 THIS IS A SEAM TEST, NOT A COMPONENT TEST. `resolveIngestionError` is verified in isolation by
 * `resolve-ingestion-error-missing-media.test.ts`, and `resolveArticleImageScan` is a moderator
 * override path that reuses it. Both surfaces being individually correct says nothing about the
 * pair: the guard was added to a function whose OTHER caller was never re-examined, and what
 * matters here is what the new throw does to the work that follows it.
 *
 * The property: when the media is absent, the refusal must propagate out of
 * `resolveArticleImageScan` AND the two side effects after the call — the article-level ingestion
 * recompute and the search-index re-queue — must not run. Publishing is what those two publish; a
 * guard that threw but left them running would put the article back into circulation pointing at a
 * broken image, which is the same harm one level up.
 */

const { headObject, getImageUploadBackend } = vi.hoisted(() => ({
  headObject: vi.fn(),
  getImageUploadBackend: vi.fn(),
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  headObject,
  getImageUploadBackend,
}));

const queueUpdate = vi.hoisted(() => vi.fn());
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  articlesSearchIndex: { queueUpdate },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resolveArticleImageScan } from '~/server/services/article.service';

const IMAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ARTICLE_ID = 77;
const IMAGE_ID = 4242;

const run = () =>
  resolveArticleImageScan({ articleId: ARTICLE_ID, imageId: IMAGE_ID, nsfwLevel: 1, userId: 7 });

const ownMocks = [headObject, getImageUploadBackend, queueUpdate];

beforeEach(() => {
  // clear globally (the canonical dbMock/loggingMock defaults installed by setup.ts must survive),
  // reset only this file's own mocks — see the sibling suite for why `resetAllMocks` is wrong here.
  vi.clearAllMocks();
  for (const mock of ownMocks) mock.mockReset();
  getImageUploadBackend.mockResolvedValue({
    s3: {} as never,
    bucket: 'a-bucket',
    backend: 'backblaze',
  } as never);

  // The ownership guard that runs BEFORE resolveIngestionError: the image must be this article's
  // cover. Satisfied so every case below reaches the media guard rather than dying earlier.
  dbMock.dbRead.article.findUnique.mockResolvedValue({ coverId: IMAGE_ID } as never);
  dbMock.dbRead.imageConnection.findFirst.mockResolvedValue(null as never);
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    ingestion: 'Error',
    postId: null,
    userId: 99,
    metadata: {},
    url: IMAGE_KEY,
  } as never);

  // The article-level recompute that runs AFTER a successful override. `$transaction` in the db
  // mock invokes its callback with the same client, so the in-transaction reads are armed here.
  // Only the allowed cases reach this; the refusal cases assert it never runs.
  dbMock.dbWrite.article.findUniqueOrThrow.mockResolvedValue({
    ingestion: 'Error',
    status: 'Published',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    userId: 99,
    title: 'an article',
    content: '<p>body</p>',
    coverId: IMAGE_ID,
    moderatorNsfwLevel: 0,
  } as never);
  dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.image.findUnique.mockResolvedValue({ ingestion: 'Scanned' } as never);
});

describe('resolveArticleImageScan — the missing-media guard reaches this caller too', () => {
  it('REFUSES the override when the bucket says the media is absent', async () => {
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(run()).rejects.toThrow(MISSING_MEDIA_PUBLISH_MESSAGE);

    // The image write is the harm this guard exists to prevent.
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('surfaces it as a BAD_REQUEST, so the article UI shows the message not a 500', async () => {
    // The override is a moderator action behind `moderatorProcedure`; a 500 would render as a
    // generic failure and the moderator would simply re-click.
    headObject.mockResolvedValue({ status: 'absent' });
    await expect(run()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does NOT re-publish the article or re-queue the search index after a refusal', async () => {
    /**
     * 🔴 The seam property, and the reason this file exists rather than trusting the component
     * suite. Both statements after the guarded call are publishing steps: the recompute is what
     * lifts the ARTICLE out of Error/Blocked, and the search-index update is what puts it back in
     * front of users. A refusal that let either run would return the article to circulation still
     * pointing at an image that 404s — the same harm the guard blocks one level down.
     *
     * This holds because the throw precedes them, which is a property of ORDER. Nothing else
     * asserts that order, so re-ordering the call — or wrapping it in a try/catch that swallows —
     * would be invisible without this case.
     */
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(run()).rejects.toThrow();

    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('completes the override normally when the media is present', async () => {
    /**
     * The discriminating half. Without it every assertion above is satisfied by a
     * `resolveArticleImageScan` that throws unconditionally, which would BREAK the override
     * entirely — a far worse regression than the one the guard prevents.
     */
    headObject.mockResolvedValue({ status: 'present', size: 4096 });

    await expect(run()).resolves.toBeUndefined();

    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
    expect(queueUpdate).toHaveBeenCalledWith([{ id: ARTICLE_ID, action: expect.anything() }]);
  });

  it('never consults the bucket for a url that is not a key', async () => {
    // Article images are the population most likely to hold a caller-supplied url: the
    // `edge-media` sync copies the attribute verbatim out of sanitized HTML. Probing those would
    // 404 and refuse a legitimate override with no way to overrule it.
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ingestion: 'Error',
      postId: null,
      userId: 99,
      metadata: {},
      url: 'https://cdn.discordapp.com/avatars/123/abc.png',
    } as never);
    // Armed ABSENT: if the probe ran, the override would be refused.
    headObject.mockResolvedValue({ status: 'absent' });

    await expect(run()).resolves.toBeUndefined();

    expect(headObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });
});
