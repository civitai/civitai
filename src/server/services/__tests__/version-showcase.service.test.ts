import type { ImagesForModelVersions } from '~/server/services/image.service';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { notifications } from '~/server/notifications/client';
import { REDIS_KEYS } from '~/server/redis/client';

/**
 * The version showcase's own rules, with the database mocked: how the carousel orders a curated
 * list, which images may be a site's cover, how a cover write refuses a stale read, and what the
 * write path refuses. The community filter's SQL is covered against PGlite in
 * version-showcase.community-filter.pglite.test.ts.
 */

const mocks = vi.hoisted(() => ({
  entry: undefined as unknown,
  fetchError: null as Error | null,
  entityChanges: vi.fn(async () => undefined),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {},
  Tracker: class {
    entityChanges = mocks.entityChanges;
  },
}));

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

type Entry = { modelVersionId: number; rows: object[]; community: object[] };
/**
 * The showcase reads from the database, answered from `mocks.entry` as the database would: its
 * rows (failing with `mocks.fetchError`), the community images that pass the filters, their live
 * ratings, and the versions a cover is featured on (all of model 1). Anything else answers empty.
 */
const answerShowcase = (async (query: unknown) => {
  const sql = (
    Array.isArray(query) ? (query as string[]) : (query as { strings?: string[] })?.strings ?? []
  ).join('?');
  const entry = mocks.entry as Entry | undefined;
  if (sql.includes('SELECT s."modelVersionId", s."imageId", s.site, s.source')) {
    if (mocks.fetchError) throw mocks.fetchError;
    return (entry?.rows ?? []).map((row) => ({ modelVersionId: entry!.modelVersionId, ...row }));
  }
  if (sql.includes('u.username AS "authorUsername"'))
    return (entry?.community ?? []).map((image) => ({
      modelVersionId: entry!.modelVersionId,
      galleryHiddenUserIds: null,
      ...image,
    }));
  if (sql.includes('SELECT i.id, i."nsfwLevel" FROM "Image" i'))
    return (entry?.community ?? []).map((image) => image as { id: number; nsfwLevel: number });
  if (sql.includes('SELECT DISTINCT s."modelVersionId", mv."modelId", s."imageId"'))
    return (entry?.rows ?? [])
      .filter((row) => (row as { source: string }).source === 'Community')
      .map((row) => ({
        modelVersionId: entry!.modelVersionId,
        modelId: 1,
        imageId: (row as { imageId: number }).imageId,
      }));
  return [];
}) as never;

let notify: ReturnType<typeof vi.spyOn>;

/** The model ids each level recompute (`updateModelNsfwLevels`) ran for. */
const levelRecomputes = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.flatMap(([query]) => {
    const sql = query as { strings?: string[]; values?: unknown[] };
    return (sql?.strings ?? []).join('').includes('bit_or(mv."nsfwLevel")') ? [sql.values] : [];
  });

beforeEach(async () => {
  vi.clearAllMocks();
  // The showcase cache keeps a local copy too: each test reads its own entry.
  await showcase.getVersionShowcaseCache().bust([VERSION]);
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockImplementation(answerShowcase);
  dbMock.dbRead.$queryRaw.mockImplementation(answerShowcase);
  notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined as never);
  mocks.entry = undefined;
  mocks.fetchError = null;
});

describe('withCuratedShowcases: the public API list', () => {
  const owner = (id: number) => ({ id, nsfwLevel: 1 } as unknown as ImagesForModelVersions);

  it('replaces a curated version’s list with its showcase, community images included', async () => {
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [
        row(9, 'red', { source: 'Community', position: 0 }),
        row(2, 'red', { excluded: true }),
      ],
      community: [{ id: 9, site: 'red', nsfwLevel: 1 }],
    };
    const result = await showcase.withCuratedShowcases(
      { [VERSION]: { images: [owner(1), owner(2)] } },
      'red'
    );
    expect(result[VERSION].images.map((image) => image.id)).toEqual([9, 1]);
  });

  it('keeps an uncurated version’s list, and every list when the showcase can’t be read', async () => {
    const byVersion = { [VERSION]: { images: [owner(1)] } };
    mocks.entry = { modelVersionId: VERSION, rows: [], community: [] };
    expect((await showcase.withCuratedShowcases(byVersion, 'red'))[VERSION]).toBe(
      byVersion[VERSION]
    );
    mocks.fetchError = new Error('redis down');
    expect(await showcase.withCuratedShowcases(byVersion, 'red')).toBe(byVersion);
  });
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

  it('is null when the creator curated neither site, so the carousel keeps today’s list', async () => {
    mocks.entry = { modelVersionId: VERSION, rows: [], community: [] };
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'com',
      ownerImageIds: [1],
      coverImageId: null,
    });
    expect(ids).toBeNull();
  });

  it('serves the only curated showcase on both sites, with only PG and PG-13 community images on .com', async () => {
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [
        row(2, 'red', { position: 0 }),
        row(8, 'red', { source: 'Community', position: 1 }),
        row(9, 'red', { source: 'Community', position: 2 }),
      ],
      community: [
        { id: 8, site: 'red', nsfwLevel: 1 },
        { id: 9, site: 'red', nsfwLevel: 4 },
      ],
    };
    const on = (site: 'com' | 'red') =>
      showcase.getVersionShowcaseImageIds({
        modelVersionId: VERSION,
        site,
        ownerImageIds: [1, 2],
        coverImageId: null,
      });
    expect(await on('red')).toEqual([2, 8, 9, 1]);
    expect(await on('com')).toEqual([2, 8, 1]);
  });

  it('keeps a site’s own curation when both are curated', async () => {
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [row(2, 'red', { position: 0 }), row(1, 'com', { position: 0 })],
      community: [],
    };
    const ids = await showcase.getVersionShowcaseImageIds({
      modelVersionId: VERSION,
      site: 'com',
      ownerImageIds: [1, 2],
      coverImageId: null,
    });
    expect(ids).toEqual([1, 2]);
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
    mocks.entry = {
      modelVersionId: VERSION,
      rows: sites.map((site) => row(imageId, site as 'com' | 'red', { source: 'Community' })),
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

  it('accepts a community image featured on civitai.com as the .com cover', async () => {
    featuredOn(77, ['com']);
    await expect(
      cover.assertCoverImagesValid({ ...base, sfwCoverImageId: 77 })
    ).resolves.toBeUndefined();
  });

  it('refuses one rated above PG-13 as the .com cover', async () => {
    featuredOn(77, ['com'], 4);
    await expect(cover.assertCoverImagesValid({ ...base, sfwCoverImageId: 77 })).rejects.toThrow(
      'The civitai.com cover must be an image rated PG or PG-13.'
    );
  });

  it('refuses an image featured only on civitai.red as the .com cover', async () => {
    featuredOn(77, ['red']);
    await expect(cover.assertCoverImagesValid({ ...base, sfwCoverImageId: 77 })).rejects.toThrow(
      /civitai.com cover/
    );
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
    // The model's level is recomputed, for the cover it no longer has.
    expect(levelRecomputes()).toHaveLength(1);
    expect(levelRecomputes()[0]).toContain(1);
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
      where: { removed?: boolean; site?: string };
    }) =>
      args.where.removed && (args.where.site ?? 'red') === 'red'
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
    ).rejects.toThrow(/removed from your showcase by its author or a moderator/);
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
      where: { removed?: boolean };
    }) => (args.where.removed ? [] : [{ imageId: 78 }])) as never);
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
      // A removal that lands after the tombstone check is kept, not overwritten.
      skipDuplicates: true,
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

  it('still succeeds and notifies when the cover check after the save fails', async () => {
    let injected = 0;
    const answer = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation((async (query: { strings?: string[] }) => {
      const sql = (Array.isArray(query) ? query : query.strings ?? []).join('');
      if (sql.includes('LEFT JOIN "Image" ci')) {
        injected += 1;
        throw new Error('primary unavailable');
      }
      return answer(query as never);
    }) as never);
    await expect(
      showcase.setVersionShowcase({
        modelVersionId: VERSION,
        site: 'red',
        items: [{ imageId: 77 }],
        userId: 5,
        isModerator: false,
      })
    ).resolves.toEqual({ modelVersionId: VERSION, site: 'red' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(injected).toBe(1);
  });
});

describe('getCoverImages: a community cover on a model card', () => {
  const featuredOnRedOnly = () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [row(77, 'red', { source: 'Community' })],
      community: [{ id: 77, site: 'red', nsfwLevel: 1, modelVersionId: VERSION }],
    };
  };
  const coverFor = (site: 'com' | 'red') =>
    cover.getCoverImages({
      covers: [{ modelId: 1, ownerId: 5, coverId: 77, site }],
      modelVersionImages: {},
      sameVersionOnly: false,
    });

  it('serves an image featured on civitai.red as the .red cover', async () => {
    featuredOnRedOnly();
    expect((await coverFor('red')).get(1)).toMatchObject({ id: 77 });
  });

  it('leaves it out as the .com cover', async () => {
    featuredOnRedOnly();
    expect((await coverFor('com')).has(1)).toBe(false);
  });
});

// The tombstone SQL itself runs against PGlite in version-showcase.community-filter.pglite.test.ts.
const tombstoneWrites = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.filter(([query]) =>
    (Array.isArray(query) ? (query as string[]) : []).join('').includes('removed = TRUE')
  );
const publishedVersion = () =>
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
    id: VERSION,
    status: 'Published',
    model: { id: 1, name: 'Model', userId: 5, nsfw: false, status: 'Published' },
  } as never);

describe('moderatorRemoveFromVersionShowcase', () => {
  it('leaves a tombstone instead of deleting, so the creator can’t feature it again', async () => {
    publishedVersion();
    await showcase.moderatorRemoveFromVersionShowcase({ modelVersionId: VERSION, imageId: 77 });
    expect(tombstoneWrites()).toHaveLength(1);
    expect(dbMock.dbWrite.modelVersionShowcaseItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe('removeMyImageFromVersionShowcase', () => {
  it('refuses to remove an image that isn’t the caller’s', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: 8 } as never);
    await expect(
      showcase.removeMyImageFromVersionShowcase({ modelVersionId: VERSION, imageId: 77, userId: 9 })
    ).rejects.toThrow(/your own images/);
    expect(tombstoneWrites()).toHaveLength(0);
  });

  it('leaves a tombstone on the author’s own image', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: 9 } as never);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(2 as never);
    publishedVersion();
    await showcase.removeMyImageFromVersionShowcase({
      modelVersionId: VERSION,
      imageId: 77,
      userId: 9,
    });
    expect(tombstoneWrites()).toHaveLength(1);
    expect(dbMock.dbWrite.modelVersionShowcaseItem.deleteMany).not.toHaveBeenCalled();
  });

  it('says so when the image isn’t featured there', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: 9 } as never);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0 as never);
    await expect(
      showcase.removeMyImageFromVersionShowcase({ modelVersionId: VERSION, imageId: 77, userId: 9 })
    ).rejects.toThrow(/isn’t featured/);
  });
});

describe('getVersionShowcaseEditor: what the editor is sent', () => {
  const pg = { id: 1, nsfwLevel: 1 };
  const x = { id: 2, nsfwLevel: 16 };
  beforeEach(() => {
    publishedVersion();
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      nsfw: false,
      sfwName: null,
      coverImageId: null,
      sfwCoverImageId: null,
      modelVersions: [{ id: VERSION }],
    } as never);
    dbMock.dbWrite.modelVersionShowcaseItem.findMany.mockResolvedValue([]);
    // The creator's images, as their version cache holds them.
    installFakeCacheRedis();
    void redisMock.redis.packed.set(
      `${REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION}:${VERSION}` as never,
      { modelVersionId: VERSION, images: [pg, x] } as never
    );
    mocks.entry = {
      modelVersionId: VERSION,
      rows: [row(3, 'red', { source: 'Community' }), row(4, 'red', { source: 'Community' })],
      community: [
        { ...pg, id: 3 },
        { ...x, id: 4 },
      ],
    };
  });
  const editor = (safeOnly: boolean) =>
    showcase.getVersionShowcaseEditor({
      modelVersionId: VERSION,
      userId: 5,
      isModerator: false,
      safeOnly,
    });

  it('sends a viewer who cannot view mature content no image above PG-13', async () => {
    const data = await editor(true);
    expect(data.ownerImages.map((image) => image.id)).toEqual([1]);
    expect(data.community.map((image) => image.id)).toEqual([3]);
  });

  it.each([
    ['its own civitai.com cover', 5, true],
    ['a featured civitai.com cover', 6, false],
  ])(
    'warns about the civitai.com listing of a mature model with a civitai.com title and %s',
    async (_label, coverUserId, warns) => {
      dbMock.dbWrite.model.findUnique.mockResolvedValue({
        nsfw: true,
        sfwName: 'Safe title',
        coverImageId: null,
        sfwCoverImageId: 50,
        modelVersions: [{ id: VERSION }],
      } as never);
      dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: coverUserId } as never);
      expect((await editor(false)).listedOnComByOwnCover).toBe(warns);
    }
  );

  it('sends every image to a viewer who can', async () => {
    const data = await editor(false);
    expect(data.ownerImages.map((image) => image.id)).toEqual([1, 2]);
    expect(data.community.map((image) => image.id)).toEqual([3, 4]);
  });
});

describe('setVersionShowcaseCover: what it refuses', () => {
  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      userId: 5,
      modelVersions: [{ id: VERSION }],
    } as never);
  });
  const setCover = (userId = 5) =>
    showcase.setVersionShowcaseCover({
      modelId: 1,
      site: 'com',
      imageId: 77,
      userId,
      isModerator: false,
    });

  it('refuses anyone but the creator', async () => {
    await expect(setCover(9)).rejects.toThrow(/Only the model’s creator/);
    expect(levelRecomputes()).toEqual([]);
  });

  it('refuses a community image not featured in the latest version on that site', async () => {
    dbMock.dbWrite.modelVersionShowcaseItem.findUnique.mockResolvedValue(null);
    await expect(setCover()).rejects.toThrow(/Feature this image/);
  });

  it('refuses a community image its author or a moderator removed', async () => {
    dbMock.dbWrite.modelVersionShowcaseItem.findUnique.mockResolvedValue({
      source: 'Community',
      removed: true,
    } as never);
    await expect(setCover()).rejects.toThrow(/Feature this image/);
  });
});

describe('hasCuratedShowcase: keeping a curated response out of the shared cache', () => {
  it('reads a version with showcase rows as curated, and one without as not', async () => {
    mocks.entry = { modelVersionId: VERSION, rows: [row(1, 'red')], community: [] };
    expect(await showcase.hasCuratedShowcase([VERSION])).toBe(true);
    mocks.entry = { modelVersionId: VERSION, rows: [], community: [] };
    await showcase.refreshVersionShowcases([VERSION]);
    expect(await showcase.hasCuratedShowcase([VERSION])).toBe(false);
  });

  it('reads a failed read as curated, so the response is not shared', async () => {
    mocks.fetchError = new Error('redis down');
    // A version no other test has read, so nothing is cached for it.
    expect(await showcase.hasCuratedShowcase([VERSION + 1])).toBe(true);
  });
});
