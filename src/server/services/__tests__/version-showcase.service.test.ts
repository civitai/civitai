import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The version showcase's own rules, with the database mocked: how the carousel orders a curated
 * list, which images may be a site's cover, how a cover write refuses a stale read, and what the
 * write path refuses. The community filter's SQL is covered against PGlite in
 * version-showcase.community-filter.pglite.test.ts.
 */

const mocks = vi.hoisted(() => ({
  entry: undefined as unknown,
  fetchError: null as Error | null,
  communityCovers: new Map<number, { image: { nsfwLevel: number }; sites: Set<string> }>(),
  queueComFaceRecheck: vi.fn(async () => undefined),
  updateModelNsfwLevels: vi.fn(async () => undefined),
  bustPublicModelResponseCache: vi.fn(async () => undefined),
  queueUpdate: vi.fn(async () => undefined),
  entityChanges: vi.fn(async () => undefined),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: () => ({
    fetch: async (ids: number[]) => {
      if (mocks.fetchError) throw mocks.fetchError;
      return Object.fromEntries(ids.map((id) => [id, mocks.entry]));
    },
    refresh: async () => undefined,
  }),
}));
const notify = vi.hoisted(() => vi.fn(async (_args: unknown) => undefined));
vi.mock('~/server/services/notification.service', () => ({ createNotification: notify }));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => null,
}));
vi.mock('~/server/services/model-com-face-recheck.service', () => ({
  queueComFaceRecheck: mocks.queueComFaceRecheck,
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateModelNsfwLevels: mocks.updateModelNsfwLevels,
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: mocks.bustPublicModelResponseCache,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  modelsSearchIndex: { queueUpdate: mocks.queueUpdate },
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {},
  Tracker: class {
    entityChanges = mocks.entityChanges;
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const showcase = await import('../version-showcase.service');
const cover = await import('../model-cover.service');
const { pickCoverImageId } = await import('~/shared/utils/model-sfw-face');
const { VERSION_SHOWCASE_LIMIT } = await import('~/shared/constants/version-showcase.constants');

const VERSION = 100;
const row = (imageId: number, site: 'com' | 'red', extra: object = {}) => ({
  imageId,
  site,
  source: 'Owner' as const,
  position: null,
  excluded: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
  mocks.entry = undefined;
  mocks.fetchError = null;
  mocks.communityCovers = new Map();
});

describe('getVersionShowcaseImageIds: the carousel order of a curated list', () => {
  it('puts the cover first, then positioned items, then the rest of the owner images, without hidden ones', async () => {
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [
        row(2, 'red', { excluded: true }),
        row(9, 'red', { source: 'Community', position: 0 }),
        row(3, 'red', { position: 1 }),
      ],
      community: [{ id: 9, site: 'red' }],
    };
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'red',
      ownerImageIds: [1, 2, 3, 4],
      coverImageId: 4,
    });
    expect(ids).toEqual([4, 9, 3, 1]);
  });

  it('is null for a site the creator never curated, so the carousel keeps today’s list', async () => {
    mocks.entry = { modelVersionId: VERSION, rows: [row(1, 'red')], community: [] };
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'com',
      ownerImageIds: [1],
      coverImageId: null,
    });
    expect(ids).toBeNull();
  });

  it('leaves out a community row that no longer passes the filters', async () => {
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [row(9, 'red', { source: 'Community', position: 0 })],
      community: [],
    };
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'red',
      ownerImageIds: [1],
      coverImageId: null,
    });
    expect(ids).toEqual([1]);
  });

  it('caps the list at the carousel limit', async () => {
    const owner = Array.from({ length: 30 }, (_, i) => i + 1);
    mocks.entry = { modelVersionId: VERSION, rows: [row(1, 'red')], community: [] };
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'red',
      ownerImageIds: owner,
      coverImageId: null,
    });
    expect(ids).toHaveLength(VERSION_SHOWCASE_LIMIT);
  });

  it('falls back to today’s carousel when the showcase can’t be read', async () => {
    mocks.fetchError = new Error('relation "ModelVersionShowcaseItem" does not exist');
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'red',
      ownerImageIds: [1],
      coverImageId: null,
    });
    expect(ids).toBeNull();
  });
});

describe('pickCoverImageId: the .com cover of a model without a .com title', () => {
  it('applies to a non-mature model, and not to a mature one', () => {
    const model = { coverImageId: 10, sfwCoverImageId: 20 };
    expect(pickCoverImageId({ ...model, nsfw: false }, true)).toBe(20);
    expect(pickCoverImageId({ ...model, nsfw: true }, true)).toBe(10);
    expect(pickCoverImageId({ ...model, nsfw: false }, false)).toBe(10);
    expect(pickCoverImageId({ coverImageId: 10, sfwCoverImageId: null, nsfw: false }, true)).toBe(
      10
    );
  });
});

describe('assertCoverImagesValid: which images may be a cover', () => {
  // A community image featured in the model's showcase, on the given sites.
  const featuredOn = (imageId: number, sites: string[], nsfwLevel = 1) => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      { modelVersionId: VERSION, modelId: 1, imageId },
    ] as never);
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [],
      community: sites.map((site) => ({ id: imageId, site, nsfwLevel, modelVersionId: VERSION })),
    };
  };
  const base = { modelId: 1, ownerId: 5 };

  it('accepts a community image featured in the .red showcase as the .red cover', async () => {
    featuredOn(77, ['red']);
    await expect(
      cover.assertCoverImagesValid({ ...base, coverImageId: 77 })
    ).resolves.toBeUndefined();
  });

  it('refuses an image that is neither the creator’s nor featured', async () => {
    featuredOn(77, ['red']);
    await expect(cover.assertCoverImagesValid({ ...base, coverImageId: 78 })).rejects.toThrow(
      /published images on this model/
    );
  });

  it('refuses a community image as the .com cover of a mature model', async () => {
    featuredOn(77, ['com']);
    await expect(
      cover.assertCoverImagesValid({ ...base, modelNsfw: true, sfwCoverImageId: 77 })
    ).rejects.toThrow('On a mature model the civitai.com cover must be one of your own images.');
  });

  it('accepts it on a non-mature model when it is featured on civitai.com', async () => {
    featuredOn(77, ['com']);
    await expect(
      cover.assertCoverImagesValid({ ...base, modelNsfw: false, sfwCoverImageId: 77 })
    ).resolves.toBeUndefined();
  });

  it('refuses an image featured only on civitai.red as the .com cover', async () => {
    featuredOn(77, ['red']);
    await expect(
      cover.assertCoverImagesValid({ ...base, modelNsfw: false, sfwCoverImageId: 77 })
    ).rejects.toThrow(/civitai.com cover/);
  });
});

describe('saveModelCovers: the cover gate', () => {
  const stored = {
    id: 1,
    userId: 5,
    nsfw: false,
    name: 'Model',
    description: null,
    sfwName: null,
    sfwDescription: null,
    coverImageId: 10,
    sfwCoverImageId: null,
    meta: { comFaceRemoved: { at: 'x' }, other: 1 },
  };

  it('refuses with a conflict when the covers changed since they were read', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 0 } as never);
    let caught: unknown;
    await cover
      .saveModelCovers({
        modelId: 1,
        covers: { coverImageId: null },
        actorUserId: -1,
        systemReason: 'test',
      })
      .catch((error) => (caught = error));
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('CONFLICT');
    expect(dbMock.dbWrite.model.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, coverImageId: 10, sfwCoverImageId: null } })
    );
  });

  it('a system clear skips the checks, records the change, and recomputes the level', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 1 } as never);
    const changed = await cover.saveModelCovers({
      modelId: 1,
      covers: { coverImageId: null },
      actorUserId: -1,
      systemReason: 'version-showcase-image-no-longer-eligible',
    });
    expect(changed).toBe(true);
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
    expect(mocks.updateModelNsfwLevels).toHaveBeenCalledWith([1]);
    expect(mocks.entityChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        field: 'coverImageId',
        actorRole: 'system',
        reason: 'version-showcase-image-no-longer-eligible',
      }),
    ]);
  });

  it('setting a .com cover ends the listing re-check’s removal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stored as never);
    dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 1 } as never);
    dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 30, nsfwLevel: 1 }] as never);
    await cover.saveModelCovers({ modelId: 1, covers: { sfwCoverImageId: 30 }, actorUserId: 5 });
    const data = (dbMock.dbWrite.model.updateMany.mock.calls[0][0] as { data: { meta: object } })
      .data;
    expect(data.meta).toEqual({ other: 1 });
  });
});

describe('setVersionShowcase: what the write path refuses', () => {
  const version = {
    id: VERSION,
    status: 'Published',
    model: { id: 1, name: 'Model', userId: 5, nsfw: false, status: 'Published' },
  };
  beforeEach(() => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(version as never);
    dbMock.dbWrite.modelVersionShowcaseItem.findMany.mockResolvedValue([]);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
  });
  const set = (userId: number, isModerator = false) =>
    showcase.setVersionShowcase({
      modelVersionId: VERSION,
      site: 'red',
      items: [{ imageId: 77 }],
      userId,
      isModerator,
    });

  it('refuses someone who is neither the creator nor a moderator', async () => {
    await expect(set(6)).rejects.toThrow(/Only the model’s creator/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an image its author removed, even on the other site', async () => {
    // The author removed it while it was featured on .red only; the save is for the other site.
    dbMock.dbWrite.modelVersionShowcaseItem.findMany.mockImplementation((async (args: {
      where: { removedByContributor?: boolean; site?: string };
    }) =>
      args.where.removedByContributor && (args.where.site ?? 'red') === 'red'
        ? [{ imageId: 77 }]
        : []) as never);
    await expect(
      showcase.setVersionShowcase({
        modelVersionId: VERSION,
        site: 'com',
        items: [{ imageId: 77 }],
        userId: 5,
        isModerator: false,
      })
    ).rejects.toThrow(/removed it from your showcase/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an image that does not pass the showcase filters', async () => {
    await expect(set(5)).rejects.toThrow(/can’t be featured/);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('setVersionShowcase: a valid save', () => {
  const version = {
    id: VERSION,
    status: 'Published',
    model: { id: 1, name: 'Model', userId: 5, nsfw: false, status: 'Published' },
  };
  beforeEach(() => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(version as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ username: 'creator' } as never);
    // Image 78 was featured before this save; 77 is new.
    dbMock.dbWrite.modelVersionShowcaseItem.findMany.mockImplementation((async (args: {
      where: { removedByContributor?: boolean };
    }) => (args.where.removedByContributor ? [] : [{ imageId: 78 }])) as never);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (query: { strings?: string[] }) => {
      const sql = (Array.isArray(query) ? query : query.strings ?? []).join('');
      if (sql.includes('CROSS JOIN'))
        return [
          { id: 77, userId: 50, nsfwLevel: 1 },
          { id: 78, userId: 51, nsfwLevel: 1 },
        ];
      if (sql.includes('p."userId" = m."userId"')) return [{ id: 1 }];
      return [];
    }) as never);
  });

  it('stores the list in order, the creator’s image as Owner and the others as Community', async () => {
    await showcase.setVersionShowcase({
      modelVersionId: VERSION,
      site: 'red',
      items: [{ imageId: 77 }, { imageId: 1, excluded: true }, { imageId: 78 }],
      userId: 5,
      isModerator: false,
    });
    expect(dbMock.dbWrite.modelVersionShowcaseItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          imageId: 77,
          source: 'Community',
          position: null,
          excluded: false,
        }),
        expect.objectContaining({ imageId: 1, source: 'Owner', excluded: true }),
        expect.objectContaining({ imageId: 78, source: 'Community' }),
      ],
    });
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('notifies only the newly featured author, keyed once per version and image', async () => {
    await showcase.setVersionShowcase({
      modelVersionId: VERSION,
      site: 'red',
      items: [{ imageId: 77 }, { imageId: 78 }],
      userId: 5,
      isModerator: false,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 50,
        type: 'model-version-showcase-featured',
        key: 'model-version-showcase-featured:100:77',
      })
    );
  });
});

describe('removeMyImageFromVersionShowcase', () => {
  it('refuses to remove an image that isn’t the caller’s', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: 8 } as never);
    await expect(
      showcase.removeMyImageFromVersionShowcase({ modelVersionId: VERSION, imageId: 77, userId: 9 })
    ).rejects.toThrow(/your own images/);
    expect(dbMock.dbWrite.modelVersionShowcaseItem.updateMany).not.toHaveBeenCalled();
  });
});
