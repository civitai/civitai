import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';

vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  bustModelGallerySettings: vi.fn(),
  getCreatorGalleryHiddenUserIds: vi.fn(async () => []),
}));

const { bustPostVersionCache, getHeldGalleryLevel } = await import(
  '~/server/services/model.service'
);

// Model 1 is minor with PG stored, model 2 is SFW-only with PG13 stored, model 3 is unflagged.
const models: Record<number, { minor: boolean; sfwOnly: boolean; level: number }> = {
  1: { minor: true, sfwOnly: false, level: 1 },
  2: { minor: false, sfwOnly: true, level: 2 },
  3: { minor: false, sfwOnly: false, level: 31 },
};
// Version 10n belongs to model n.
const versionModel = (id: number) => Math.floor(id / 10);

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.model.findFirst.mockImplementation((async ({ where }: { where: { id: number } }) => {
      const model = models[where.id];
      return (
        model && { id: where.id, userId: 9, ...model, gallerySettings: { level: model.level } }
      );
    }) as never);
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id, modelId: versionModel(id) }))) as never);
  // Post 100n is on version 10n; post 7 is on no version.
  dbMock.dbRead.post.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id, modelVersionId: id === 7 ? null : id / 10 }))) as never);
  dbMock.dbRead.resourceReview.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ modelVersionId: where.id * 10 })) as never);
});

describe('getHeldGalleryLevel', () => {
  it('holds a request that names only the version of a held model', async () => {
    expect(await getHeldGalleryLevel({ modelVersionId: 10 })).toBe(1);
  });

  it("holds a held model's version even when the request names an unheld model", async () => {
    expect(await getHeldGalleryLevel({ modelId: 3, modelVersionId: 10 })).toBe(1);
  });

  it('holds a request that names many versions when one is of a held model', async () => {
    expect(await getHeldGalleryLevel({ modelVersionIds: [30, 10] })).toBe(1);
  });

  it('holds a request that names a post on a held model', async () => {
    expect(await getHeldGalleryLevel({ postId: 100 })).toBe(1);
  });

  it('holds a page of posts when one is on a held model', async () => {
    expect(await getHeldGalleryLevel({ postIds: [7, 100] })).toBe(1);
  });

  it('does not empty a page of posts over one it cannot find', async () => {
    dbMock.dbRead.post.findMany.mockResolvedValueOnce([{ id: 7, modelVersionId: null }] as never);
    expect(await getHeldGalleryLevel({ postIds: [7, 100] })).toBeUndefined();
  });

  it('follows a post to the version it was re-pointed to once told', async () => {
    expect(await getHeldGalleryLevel({ postId: 300 })).toBeUndefined();
    dbMock.dbRead.post.findMany.mockResolvedValue([{ id: 300, modelVersionId: 10 }] as never);
    expect(await getHeldGalleryLevel({ postId: 300 })).toBeUndefined();

    await bustPostVersionCache([300]);

    expect(await getHeldGalleryLevel({ postId: 300 })).toBe(1);
  });

  it('follows a re-pointed post even when a lagging read re-caches the old version', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      dbMock.dbRead.post.findMany.mockResolvedValue([{ id: 300, modelVersionId: 30 }] as never);
      await bustPostVersionCache([300]);
      // The replica still has the old version after the first bust's window.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await getHeldGalleryLevel({ postId: 300 })).toBeUndefined();

      dbMock.dbRead.post.findMany.mockResolvedValue([{ id: 300, modelVersionId: 10 }] as never);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await getHeldGalleryLevel({ postId: 300 })).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a storyline at the level of its one held chapter', async () => {
    // Chapters on no model (7) and on an unheld model (300), and one on held model 1 (100).
    dbMock.dbRead.post.findMany.mockResolvedValue([
      { id: 7, modelVersionId: null },
      { id: 300, modelVersionId: 30 },
      { id: 100, modelVersionId: 10 },
    ] as never);
    expect(await getHeldGalleryLevel({ postIds: [7, 300, 100] })).toBe(1);
  });

  it('serves nothing for a storyline whose held chapters allow no level in common', async () => {
    // Model 1 is held at PG and model 2 at PG13.
    expect(await getHeldGalleryLevel({ postIds: [100, 200] })).toBe(0);
  });

  it('holds nothing for a post on no model', async () => {
    expect(await getHeldGalleryLevel({ postId: 7 })).toBeUndefined();
  });

  it('serves nothing for a post it cannot find', async () => {
    dbMock.dbRead.post.findMany.mockResolvedValueOnce([] as never);
    expect(await getHeldGalleryLevel({ postId: 100 })).toBe(0);
  });

  it('holds nothing for a post whose version is gone', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValueOnce([] as never);
    expect(await getHeldGalleryLevel({ postId: 100 })).toBeUndefined();
  });

  it('fails rather than skipping a model whose settings it cannot read', async () => {
    const read = dbMock.dbRead.model.findFirst.getMockImplementation();
    for (const db of [dbMock.dbRead, dbMock.dbWrite])
      db.model.findFirst.mockImplementation((async (args: { where: { id: number } }) => {
        if (args.where.id === 1) throw new Error('read failed');
        return read?.(args as never);
      }) as never);

    await expect(getHeldGalleryLevel({ modelIds: [3, 1] })).rejects.toThrow('read failed');
  });

  it('holds nothing for a model it does not know', async () => {
    expect(await getHeldGalleryLevel({ modelId: 999 })).toBeUndefined();
  });

  it('holds a request that names a review of a held model', async () => {
    expect(await getHeldGalleryLevel({ reviewId: 1 })).toBe(1);
  });

  it('serves nothing for a review it cannot find', async () => {
    dbMock.dbRead.resourceReview.findUnique.mockResolvedValue(null as never);
    expect(await getHeldGalleryLevel({ reviewId: 1 })).toBe(0);
  });

  it('serves nothing for a version it cannot find', async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValueOnce([] as never);
    expect(await getHeldGalleryLevel({ modelVersionId: 10 })).toBe(0);
  });

  it("does not empty a hub's versions over one it cannot find", async () => {
    dbMock.dbRead.modelVersion.findMany.mockResolvedValueOnce([{ id: 30, modelId: 3 }] as never);
    expect(await getHeldGalleryLevel({ modelVersionIds: [30, 99] })).toBeUndefined();
  });

  it('holds a request that names many models when one is held', async () => {
    expect(await getHeldGalleryLevel({ modelIds: [3, 2] })).toBe(2);
  });

  it('holds a request that names only a held model', async () => {
    expect(await getHeldGalleryLevel({ modelId: 2 })).toBe(2);
  });

  it('holds to what every named held model allows', async () => {
    expect(await getHeldGalleryLevel({ modelId: 1, modelVersionId: 20 })).toBe(0);
  });

  it('holds a version of a held model that did not exist when it was first asked about', async () => {
    const lookup = dbMock.dbRead.modelVersion.findMany;
    const found = lookup.getMockImplementation();
    lookup.mockResolvedValueOnce([] as never);
    expect(await getHeldGalleryLevel({ modelVersionId: 10 })).toBe(0);

    lookup.mockImplementation(found as never);
    expect(await getHeldGalleryLevel({ modelVersionId: 10 })).toBe(1);
  });

  it('holds a post on a held model that did not exist when it was first asked about', async () => {
    const lookup = dbMock.dbRead.post.findMany;
    const found = lookup.getMockImplementation();
    lookup.mockResolvedValueOnce([] as never);
    expect(await getHeldGalleryLevel({ postId: 100 })).toBe(0);

    lookup.mockImplementation(found as never);
    expect(await getHeldGalleryLevel({ postId: 100 })).toBe(1);
  });

  it('holds nothing for an unheld model and its version', async () => {
    expect(await getHeldGalleryLevel({ modelId: 3, modelVersionId: 30 })).toBeUndefined();
  });
});
