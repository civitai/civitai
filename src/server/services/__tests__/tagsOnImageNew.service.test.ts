import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  applyTagRules,
  deleteTagsOnImageNew,
  insertTagsOnImageNew,
  upsertTagsOnImageNew,
} from '../tagsOnImageNew.service';
import * as systemCache from '../system-cache';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgDbWrite } from '~/server/db/pgDb';
import { imageTagsCache, refreshThumbnailCache, tagIdsForImagesCache } from '~/server/redis/caches';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { refreshProfilePicturesForImages } from '~/server/services/user.service';
import { queueDocumentsForImageMinorChanges } from '~/server/services/image-models-reindex.service';

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {},
  pgDbWrite: { query: vi.fn() },
}));
vi.mock('~/server/redis/caches', () => ({
  tagIdsForImagesCache: { bust: vi.fn() },
  refreshThumbnailCache: vi.fn(),
  imageTagsCache: { bust: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
}));
// Hand-listed rather than `importOriginal`: the real user.service pulls in most of the server, and
// this file exercises only the tag write.
vi.mock('~/server/services/user.service', () => ({
  refreshProfilePicturesForImages: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/image-models-reindex.service', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));

vi.mock('../system-cache', () => ({
  getTagRules: vi.fn(),
  getModeratedTags: vi.fn(),
}));

describe('tagsOnImageNew.service', () => {
  describe('applyTagRules', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should correctly deduplicate Append rules recursively and prevent exponential growth', async () => {
      // Mock tag rules to simulate a cascading append scenario:
      // tag 1 -> appends tag 2
      // tag 2 -> appends tag 3
      // tag 3 -> appends tag 4
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        { toId: 1, fromId: 2, type: 'Append', fromTag: 'two', toTag: 'one', createdAt: new Date() },
        {
          toId: 2,
          fromId: 3,
          type: 'Append',
          fromTag: 'three',
          toTag: 'two',
          createdAt: new Date(),
        },
        {
          toId: 3,
          fromId: 4,
          type: 'Append',
          fromTag: 'four',
          toTag: 'three',
          createdAt: new Date(),
        },
      ]);

      const initialArgs = [{ imageId: 10, tagId: 1, confidence: 100, source: 'User' }] as any[];

      const result = await applyTagRules(initialArgs);

      // The rules should process sequentially:
      // 1. Appends 2 => [1, 2]
      // 2. Appends 3 => [1, 2, 3]
      // 3. Appends 4 => [1, 2, 3, 4]
      expect(result).toHaveLength(4);
      const tagIds = result.map((r) => r.tagId).sort();
      expect(tagIds).toEqual([1, 2, 3, 4]);

      const tag4 = result.find((r) => r.tagId === 4);
      expect(tag4?.confidence).toBe(70);
      expect(tag4?.source).toBe('Computed');
    });

    it('should correctly handle Replace rules', async () => {
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        {
          toId: 5,
          fromId: 6,
          type: 'Replace',
          fromTag: 'six',
          toTag: 'five',
          createdAt: new Date(),
        },
      ]);

      const initialArgs = [{ imageId: 20, tagId: 5, confidence: 90, source: 'WD14' }] as any[];

      const result = await applyTagRules(initialArgs);

      expect(result).toHaveLength(1);
      expect(result[0].tagId).toBe(6);
      expect(result[0].confidence).toBe(90); // Replace preserves original confidence
      expect(result[0].source).toBe('WD14'); // Replace preserves original source
    });

    it('should not duplicate tags when multiple incoming tags map to the same Append rule', async () => {
      // Multiple starting tags matching the same rule
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        {
          toId: 7,
          fromId: 9,
          type: 'Append',
          fromTag: 'nine',
          toTag: 'seven',
          createdAt: new Date(),
        },
        {
          toId: 8,
          fromId: 9,
          type: 'Append',
          fromTag: 'nine',
          toTag: 'eight',
          createdAt: new Date(),
        },
      ]);

      const initialArgs = [
        { imageId: 30, tagId: 7, confidence: 100, source: 'User' },
        { imageId: 30, tagId: 8, confidence: 100, source: 'User' },
      ] as any[];

      const result = await applyTagRules(initialArgs);

      // Result should be 7, 8, and 9 (only one 9, not two)
      expect(result).toHaveLength(3);
      const tagIds = result.map((r) => r.tagId).sort();
      expect(tagIds).toEqual([7, 8, 9]);
    });

    it('should not clobber a pre-existing tag when an Append rule targets it', async () => {
      // Rule appends tag 11 whenever tag 12 is present, but tag 11 already
      // exists as a genuine high-confidence User tag. First-wins must preserve it
      // rather than downgrading it to { confidence: 70, source: 'Computed' }.
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        {
          toId: 12,
          fromId: 11,
          type: 'Append',
          fromTag: 'eleven',
          toTag: 'twelve',
          createdAt: new Date(),
        },
      ]);

      const initialArgs = [
        { imageId: 40, tagId: 11, confidence: 100, source: 'User' },
        { imageId: 40, tagId: 12, confidence: 95, source: 'WD14' },
      ] as any[];

      const result = await applyTagRules(initialArgs);

      expect(result).toHaveLength(2);
      const tag11 = result.find((r) => r.tagId === 11);
      expect(tag11?.confidence).toBe(100);
      expect(tag11?.source).toBe('User');
    });
  });
});

describe('blocked-level tags written after the scan', () => {
  const URINE = 100;
  const XXX = 101;
  const SAFE = 102;

  const reviewInserts = () =>
    vi
      .mocked(dbMock.dbWrite.$queryRawUnsafe)
      .mock.calls.map(([sql]) => String(sql))
      .filter((sql) => sql.includes('ImageTagForReview'));
  const queueQueries = () =>
    vi
      .mocked(dbMock.dbWrite.$queryRaw)
      .mock.calls.filter(([strings]) =>
        (strings as TemplateStringsArray).join('').includes(`"needsReview" = 'tag'`)
      );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemCache.getTagRules).mockResolvedValue([]);
    vi.mocked(systemCache.getModeratedTags).mockResolvedValue([
      { id: URINE, name: 'urine', nsfwLevel: 32 },
      { id: XXX, name: 'xxx', nsfwLevel: 16 },
    ]);
  });

  it('queues the image for tag review with the blocked tag that raised it', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([{ imageId: 7, tagId: URINE }]);

    await insertTagsOnImageNew([
      { imageId: 7, tagId: URINE, source: 'User' },
      { imageId: 7, tagId: XXX, source: 'User' },
    ]);

    expect(queueQueries()).toHaveLength(1);
    const [, written] = queueQueries()[0];
    expect(JSON.parse(written as string)).toEqual([{ imageId: 7, tagId: URINE, source: 'User' }]);
    expect(reviewInserts()).toEqual([expect.stringContaining(`(7, ${URINE})`)]);
  });

  it('refreshes the home blocks of the images it held for review', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([{ imageId: 7, tagId: URINE }]);

    await insertTagsOnImageNew([{ imageId: 7, tagId: URINE, source: 'User' }]);

    // The refresh's collection lookup, seen at the database: the image ids bound as one array.
    const lookedUp = vi
      .mocked(dbMock.dbRead.$queryRaw)
      .mock.calls.map(([query]) => query as unknown as { sql?: string; values?: unknown[] })
      .filter((query) => !!query?.sql?.includes('"CollectionItem"'))
      .flatMap((query) => (query.values ?? []).filter(Array.isArray));
    expect(lookedUp).toEqual([[7]]);
  });

  it('refreshes the thumbnail cache, parent videos included, for re-rated images', async () => {
    await upsertTagsOnImageNew([
      { imageId: 7, tagId: XXX },
      { imageId: 8, tagId: SAFE },
    ]);

    expect(refreshThumbnailCache).toHaveBeenCalledTimes(1);
    expect(refreshThumbnailCache).toHaveBeenCalledWith([7]);
  });

  it('does not touch review state when no blocked-level tag was written', async () => {
    await upsertTagsOnImageNew([
      { imageId: 7, tagId: XXX },
      { imageId: 7, tagId: SAFE },
    ]);

    expect(queueQueries()).toHaveLength(0);
    expect(reviewInserts()).toHaveLength(0);
  });

  it('creates no review rows when the database flagged nothing', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([]);

    await upsertTagsOnImageNew([{ imageId: 7, tagId: URINE, disabled: true }]);

    expect(queueQueries()).toHaveLength(1);
    expect(reviewInserts()).toHaveLength(0);
  });

  it('queues a blocked tag that a tag rule appended', async () => {
    vi.mocked(systemCache.getTagRules).mockResolvedValue([
      {
        toId: SAFE,
        fromId: URINE,
        type: 'Append',
        fromTag: 'urine',
        toTag: 'pee',
        createdAt: new Date(),
      },
    ]);
    vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([{ imageId: 9, tagId: URINE }]);

    await insertTagsOnImageNew([{ imageId: 9, tagId: SAFE, source: 'User' }]);

    expect(queueQueries()).toHaveLength(1);
    expect(reviewInserts()).toEqual([expect.stringContaining(`(9, ${URINE})`)]);
  });
});

/**
 * Avatars are shown or hidden on their picture's rating, read from a day-long profile-picture cache.
 * A tag write that re-rates an image (a vote, a tag rule, a moderator tag tool) has to refresh the
 * cached picture of any user whose avatar it is, or a picture voted from PG up to R keeps passing
 * the safe-for-work gate until the TTL.
 */
describe('profile pictures re-rated by a tag write', () => {
  const R_TAG = 201;
  const PLAIN_TAG = 202;
  const RATED_IMAGE = 61;
  const UNRATED_IMAGE = 62;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemCache.getTagRules).mockResolvedValue([]);
    vi.mocked(systemCache.getModeratedTags).mockResolvedValue([
      { id: R_TAG, name: 'r-tag', nsfwLevel: 4 },
    ]);
  });

  it('refreshes the cached profile pictures of the re-rated images, after the recompute', async () => {
    await upsertTagsOnImageNew([
      { imageId: RATED_IMAGE, tagId: R_TAG },
      { imageId: UNRATED_IMAGE, tagId: PLAIN_TAG },
    ]);

    expect(refreshProfilePicturesForImages).toHaveBeenCalledTimes(1);
    expect(refreshProfilePicturesForImages).toHaveBeenCalledWith([RATED_IMAGE]);
    // After the level write, or the refresh re-reads the old rating.
    expect(vi.mocked(dbMock.dbWrite.$executeRawUnsafe).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(refreshProfilePicturesForImages).mock.invocationCallOrder[0]
    );
  });

  it('refreshes them when a removed tag lowers the rating', async () => {
    await deleteTagsOnImageNew([{ imageId: RATED_IMAGE, tagId: R_TAG }]);

    expect(refreshProfilePicturesForImages).toHaveBeenCalledWith([RATED_IMAGE]);
  });

  it('refreshes nothing when no written tag can change a rating', async () => {
    await upsertTagsOnImageNew([{ imageId: UNRATED_IMAGE, tagId: PLAIN_TAG }]);

    expect(refreshProfilePicturesForImages).not.toHaveBeenCalled();
  });
});

describe('models-index queue on a tag write', () => {
  const R_TAG = 301;
  const PLAIN_TAG = 302;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemCache.getTagRules).mockResolvedValue([]);
    vi.mocked(systemCache.getModeratedTags).mockResolvedValue([
      { id: R_TAG, name: 'r-tag', nsfwLevel: 4 },
    ]);
  });

  const written = [
    { imageId: 71, tagId: R_TAG },
    { imageId: 72, tagId: PLAIN_TAG },
  ];

  it.each([
    ['insert', insertTagsOnImageNew],
    ['upsert', upsertTagsOnImageNew],
    ['delete', deleteTagsOnImageNew],
  ] as const)('%s hands over only the re-rated images, not the written tags', async (_, write) => {
    await write(written);

    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ levelImageIds: [71] });
  });

  it('hands over no re-rated images when no written tag can change a rating', async () => {
    await upsertTagsOnImageNew([{ imageId: 72, tagId: PLAIN_TAG }]);

    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith(
      expect.objectContaining({ levelImageIds: [] })
    );
  });
});

/**
 * A song's genre change writes its tag rows inside the caller's transaction (setSongGenre): the rows
 * go on the caller's connection, and nothing that reads or announces them runs before the commit.
 * Every other caller passes no transaction and gets the writer as it always was.
 */
describe("tag writes in a caller's transaction", () => {
  const R_TAG = 401;
  const rows = [{ imageId: 81, tagId: R_TAG }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemCache.getTagRules).mockResolvedValue([]);
    vi.mocked(systemCache.getModeratedTags).mockResolvedValue([
      { id: R_TAG, name: 'r-tag', nsfwLevel: 4 },
    ]);
  });

  /** Everything a tag write does besides the row write itself. */
  const followUps = () => [
    vi.mocked(tagIdsForImagesCache.bust).mock.calls.length,
    vi.mocked(imageTagsCache.bust).mock.calls.length,
    vi.mocked(dbMock.dbWrite.$executeRawUnsafe).mock.calls.length,
    vi.mocked(queueDocumentsForImageMinorChanges).mock.calls.length,
    vi.mocked(queueImageSearchIndexUpdate).mock.calls.length,
  ];

  it.each([
    ['insert', insertTagsOnImageNew],
    ['delete', deleteTagsOnImageNew],
  ] as const)(
    '%s without one writes on the pool and runs everything after it',
    async (_, write) => {
      await write(rows);

      expect(pgDbWrite.query).toHaveBeenCalledTimes(1);
      expect(followUps()).toEqual([1, 1, 1, 1, 1]);
      expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({ ids: [81], action: 'Update' });
    }
  );

  it.each([
    ['insert', insertTagsOnImageNew],
    ['delete', deleteTagsOnImageNew],
  ] as const)(
    '%s in one writes on its client and defers the rest to the commit',
    async (_, write) => {
      const tx = { client: { query: vi.fn() }, afterCommit: [] as (() => Promise<void>)[] };

      await write(rows, tx as never);

      expect(tx.client.query).toHaveBeenCalledTimes(1);
      expect(pgDbWrite.query).not.toHaveBeenCalled();
      expect(followUps()).toEqual([0, 0, 0, 0, 0]);

      for (const run of tx.afterCommit) await run();
      expect(followUps()).toEqual([1, 1, 1, 1, 1]);
    }
  );
});
