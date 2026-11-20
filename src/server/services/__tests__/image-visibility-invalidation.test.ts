import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { env } from '~/env/client';

/**
 * When a moderator changes who may see an image, the shared copies that can still show it are
 * dropped: every link-preview card that can draw it, and the 404 gallery.
 */

const { getImageOgCardUrls } = await import(
  '~/server/services/image-visibility-invalidation.service'
);
const { updateImageAcceptableMinor } = await import('~/server/services/image.service');

const IMAGE = 7;
const card = (q: string) => `${env.NEXT_PUBLIC_BASE_URL}/api/og?${q}&v=2`;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    postId: 11,
    post: { modelVersionId: 31, modelVersion: { modelId: 21 } },
  } as never);
  dbMock.dbRead.model.findMany.mockResolvedValue([
    { id: 21, updatedAt: new Date(1000), modelVersions: [{ id: 31, status: 'Published' }] },
  ] as never);
  dbMock.dbRead.article.findMany.mockResolvedValue([{ id: 41 }] as never);
  dbMock.dbRead.imageConnection.findMany.mockResolvedValue([{ entityId: 51 }] as never);
});

describe('the link-preview cards an image can be drawn on', () => {
  it('are its own, its post, its models, its articles and its bounties, as pages link them', async () => {
    expect(await getImageOgCardUrls(IMAGE)).toEqual([
      card(`type=image&id=${IMAGE}`),
      card('type=post&id=11'),
      card('type=model&id=21&mv=31&u=1000'),
      card('type=article&id=41'),
      card('type=bounty&id=51'),
    ]);
  });

  it('look for models that use it as either cover, or own its post', async () => {
    await getImageOgCardUrls(IMAGE);
    expect(dbMock.dbRead.model.findMany.mock.calls[0][0]?.where).toEqual({
      OR: [{ coverImageId: IMAGE }, { sfwCoverImageId: IMAGE }, { id: 21 }],
    });
    expect(dbMock.dbRead.article.findMany.mock.calls[0][0]?.where).toEqual({
      OR: [{ coverId: IMAGE }, { bannerId: IMAGE }],
    });
  });

  it('are only its own when it has no post and nothing uses it', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ postId: null, post: null } as never);
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.article.findMany.mockResolvedValue([]);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([]);
    expect(await getImageOgCardUrls(IMAGE)).toEqual([card(`type=image&id=${IMAGE}`)]);
  });
});

describe('a moderator marking an image acceptable-minor', () => {
  it('drops the cached 404 gallery', async () => {
    dbMock.dbWrite.image.update.mockResolvedValue({ id: IMAGE, acceptableMinor: true } as never);
    await updateImageAcceptableMinor({ id: IMAGE, collectionId: 1, acceptableMinor: true });
    expect(redisMock.redis.purgeTags).toHaveBeenCalledWith(['image-404']);
  });
});
