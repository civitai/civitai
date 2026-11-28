import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';
import type * as Caches from '~/server/redis/caches';
import type * as ReDerive from '~/server/services/blocks/app-listing-rating-rederive.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';

// Which writes of an image's level reach the store-listing rating re-derive: a moderator's
// own decision does; a user's vote and a Knights consensus do not.

const reDerive = vi.fn<typeof ReDerive.reDeriveListingRatingsForModeratedImage>(async () => []);

vi.mock('~/server/services/blocks/app-listing-rating-rederive.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReDerive>()),
  reDeriveListingRatingsForModeratedImage: (
    ...a: Parameters<typeof ReDerive.reDeriveListingRatingsForModeratedImage>
  ) => reDerive(...a),
}));

const bustCachesForPosts = vi.fn(async (_postIds: number | number[]) => undefined);
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustCachesForPosts: (postIds: number | number[]) => bustCachesForPosts(postIds),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: vi.fn(() => Promise.resolve()),
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(() => Promise.resolve()) },
  };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => {
  const reset = { reset: vi.fn(() => Promise.resolve()) };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    poolCounters: {
      Knight: { a: [reset], b: [reset] },
      Templar: { a: [reset], b: [reset] },
    },
  };
});

const { updateImageNsfwLevel, setImagesNsfwLevel } = await import('../image.service');

const IMAGE_ID = 7301;
const MOD = 9001;
const USER = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    metadata: {},
    postId: null,
    nsfwLevel: NsfwLevel.R,
  } as never);
  // A replica that has not caught up still holds an older level: reading it would be wrong.
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    metadata: {},
    postId: null,
    nsfwLevel: NsfwLevel.X,
  } as never);
  dbMock.dbWrite.image.update.mockResolvedValue({} as never);
});

describe('updateImageNsfwLevel → listing rating re-derive', () => {
  it('a moderator’s re-rate hands the hook the image, its PREVIOUS level and the moderator', async () => {
    const level = await updateImageNsfwLevel({
      csamReview: true,
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      userId: MOD,
      isModerator: true,
    } as never);

    expect(level).toBe(NsfwLevel.PG13);
    expect(reDerive).toHaveBeenCalledTimes(1);
    expect(reDerive).toHaveBeenCalledWith({
      imageId: IMAGE_ID,
      previousNsfwLevel: NsfwLevel.R,
      actorUserId: MOD,
    });
    // After the image write, so the hook reads the new level.
    expect(dbMock.dbWrite.image.update.mock.invocationCallOrder[0]).toBeLessThan(
      reDerive.mock.invocationCallOrder[0]
    );
  });

  it('a Knights consensus locks through the moderator branch but does not reach the hook', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
    await updateImageNsfwLevel({
      csamReview: true,
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      userId: MOD,
      isModerator: true,
      activity: 'setNsfwLevelKono',
    } as never);

    expect(
      dbMock.dbWrite.$executeRaw.mock.calls.filter((call) =>
        (call[0] as unknown as string[]).join('?').includes('UPDATE "Image" i')
      )
    ).toHaveLength(1);
    expect(reDerive).not.toHaveBeenCalled();
  });

  it('a user’s rating vote does not reach the hook', async () => {
    dbMock.dbWrite.image.findFirst.mockResolvedValue({
      nsfwLevel: NsfwLevel.R,
      userId: USER,
      nsfwLevelLocked: true,
    } as never);

    await updateImageNsfwLevel({
      csamReview: true,
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.PG13,
      userId: USER,
      isModerator: false,
    } as never);

    expect(reDerive).not.toHaveBeenCalled();
  });
});

describe('updateImageNsfwLevel → version showcase cache', () => {
  it('a moderator’s re-rate refreshes the caches of the image’s post, after the write', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({
      metadata: {},
      postId: 55,
      nsfwLevel: NsfwLevel.PG,
    } as never);

    await updateImageNsfwLevel({
      csamReview: true,
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.X,
      userId: MOD,
      isModerator: true,
    } as never);

    expect(bustCachesForPosts).toHaveBeenCalledWith(55);
    expect(dbMock.dbWrite.image.update.mock.invocationCallOrder[0]).toBeLessThan(
      bustCachesForPosts.mock.invocationCallOrder[0]
    );
  });

  it('an image with no post has no showcase to refresh', async () => {
    await updateImageNsfwLevel({
      csamReview: true,
      id: IMAGE_ID,
      nsfwLevel: NsfwLevel.X,
      userId: MOD,
      isModerator: true,
    } as never);

    expect(bustCachesForPosts).not.toHaveBeenCalled();
  });
});

describe('who can move a listing rating by re-rating an image', () => {
  it('the hook has exactly one caller: the moderator branch above', () => {
    const root = path.resolve(__dirname, '../../../..');
    const callers = globSync('src/**/*.{ts,tsx}', { cwd: root })
      .map((f) => f.split(path.sep).join('/'))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => statSync(path.join(root, f)).isFile())
      .filter((f) =>
        readFileSync(path.join(root, f), 'utf8').includes('reDeriveListingRatingsForModeratedImage')
      )
      .sort();

    // The scan pipeline, user votes and owner raises write `Image.nsfwLevel` elsewhere and
    // must not appear here; neither may a second call site appear unreviewed.
    expect(callers).toEqual([
      'src/server/services/blocks/app-listing-rating-rederive.service.ts',
      'src/server/services/image.service.ts',
    ]);
  });
});

describe("policy: a rating write doesn't move a blocked row's level; re-blocking to 32 is allowed", () => {
  type Row = { ingestion: string; nsfwLevel: number; blockedFor: string | null };
  const MARKED: [string, Row][] = [
    ['ingestion Blocked', { ingestion: 'Blocked', nsfwLevel: NsfwLevel.R, blockedFor: null }],
    ['the Blocked level', { ingestion: 'Scanned', nsfwLevel: NsfwLevel.Blocked, blockedFor: null }],
    ['a block reason', { ingestion: 'Error', nsfwLevel: NsfwLevel.R, blockedFor: 'moderated' }],
  ];
  const CLEAN: Row = { ingestion: 'Scanned', nsfwLevel: NsfwLevel.R, blockedFor: null };

  describe('a moderator rating (the mod api-route and image.controller)', () => {
    // Evaluates the Prisma where the write sends against the row, as the database would.
    const matches = (row: Row & { id: number }, where: Record<string, unknown>): boolean =>
      Object.entries(where).every(([key, cond]) => {
        const value = row[key as keyof typeof row];
        if (cond && typeof cond === 'object' && 'not' in cond)
          return value !== (cond as { not: unknown }).not;
        return value === cond;
      });
    const seed = (row: Row) => {
      dbMock.dbWrite.image.findUnique.mockResolvedValue({
        metadata: {},
        postId: null,
        nsfwLevel: row.nsfwLevel,
      } as never);
      dbMock.dbWrite.image.update.mockImplementation((async ({ where }: { where: never }) => {
        if (!matches({ id: IMAGE_ID, ...row }, where))
          throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
            code: 'P2025',
            clientVersion: 'test',
          });
        return {};
      }) as never);
    };
    const rate = (nsfwLevel: number, skipBlocked?: boolean) =>
      updateImageNsfwLevel({
        csamReview: true,
        id: IMAGE_ID,
        nsfwLevel,
        userId: MOD,
        isModerator: true,
        skipBlocked,
      } as never);

    it.each(MARKED)('is refused when the row carries %s', async (_, row) => {
      seed(row);

      await expect(rate(NsfwLevel.PG13)).rejects.toThrow('This image is blocked');
      expect(reDerive).not.toHaveBeenCalled();
    });

    it.each(MARKED)(
      "is skipped for a moderator's Knights vote when the row carries %s",
      async (_, row) => {
        seed(row);

        await expect(rate(NsfwLevel.PG13, true)).resolves.toBe(row.nsfwLevel);
        expect(reDerive).not.toHaveBeenCalled();
      }
    );

    it('re-blocking it to 32 is written', async () => {
      seed(MARKED[0][1]);

      await expect(rate(NsfwLevel.Blocked)).resolves.toBe(NsfwLevel.Blocked);
    });

    it('control: an unmarked row takes the rating', async () => {
      seed(CLEAN);

      await expect(rate(NsfwLevel.PG13)).resolves.toBe(NsfwLevel.PG13);
    });
  });

  describe('a batch of moderator ratings (the image.setNsfwLevel endpoint)', () => {
    const BLOCKED_ID = IMAGE_ID + 1;
    const rows = [
      { id: IMAGE_ID, ...CLEAN },
      { id: BLOCKED_ID, ...MARKED[1][1] },
      { id: IMAGE_ID + 2, ...CLEAN },
    ];
    beforeEach(() => {
      dbMock.dbWrite.image.findMany.mockResolvedValue(rows as never);
    });
    const rateAll = (nsfwLevel: number) =>
      setImagesNsfwLevel({
        items: rows.map((row) => ({ imageId: row.id, nsfwLevel })),
        userId: MOD,
        csamReview: true,
      });

    it('refuses the whole batch before any write, naming the blocked image', async () => {
      await expect(rateAll(NsfwLevel.PG13)).rejects.toThrow(`Nothing was changed: ${BLOCKED_ID}.`);
      expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    });

    // A block that lands after the batch's check: the write's own guard refuses that item.
    it('a block landing mid-batch names the refused image and the ones already written', async () => {
      dbMock.dbWrite.image.findMany.mockResolvedValue(
        rows.map((row) => ({ ...row, ...CLEAN })) as never
      );
      dbMock.dbWrite.image.update.mockResolvedValueOnce({} as never).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
          code: 'P2025',
          clientVersion: 'test',
        })
      );

      await expect(rateAll(NsfwLevel.PG13)).rejects.toThrow(
        `Image ${BLOCKED_ID} is blocked: lift the block before rating it. Already rated: ${IMAGE_ID}.`
      );
      expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(2);
    });

    it('re-blocking the batch to 32 is not refused', async () => {
      await expect(rateAll(NsfwLevel.Blocked)).resolves.toEqual(rows.map((row) => row.id));
    });
  });

  // The consensus guard is raw SQL, run here on PGlite.
  describe('a Knights consensus', () => {
    let pg: PGlite;
    beforeAll(async () => {
      pg = new PGlite();
      await pg.exec(CSAM_LINK_TABLES_SQL);
      await pg.exec(`
        CREATE TYPE "ImageIngestionStatus" AS ENUM
          ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
        CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
        CREATE TABLE "Image" (
          id int PRIMARY KEY, url text NOT NULL DEFAULT 'key', type "MediaType" NOT NULL DEFAULT 'image',
          "mimeType" text, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
          "blockedFor" text, minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL,
          "userId" int NOT NULL DEFAULT 7, "acceptableMinor" boolean NOT NULL DEFAULT false,
          "pHash" bigint, "postId" int, metadata jsonb, "nsfwLevelLocked" boolean NOT NULL DEFAULT false
        );
        ${WITHHELD_TABLES_SQL}
        CREATE TABLE "ModActivity" ("userId" int, "entityType" text, activity text, "entityId" int);
      `);
    });
    afterAll(() => pg.close());
    beforeEach(async () => {
      await pg.exec(`TRUNCATE "Image"`);
      const raw = pgliteRaw(pg);
      dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
      dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
    });
    const seed = async (row: Row) => {
      await pg.query(
        `INSERT INTO "Image" (id, ingestion, "nsfwLevel", "blockedFor") VALUES ($1, $2, $3, $4)`,
        [IMAGE_ID, row.ingestion, row.nsfwLevel, row.blockedFor]
      );
      dbMock.dbWrite.image.findUnique.mockResolvedValue({
        metadata: {},
        postId: null,
        ...row,
      } as never);
    };
    const level = async () =>
      (
        await pg.query<{ nsfwLevel: number }>(`SELECT "nsfwLevel" FROM "Image" WHERE id = $1`, [
          IMAGE_ID,
        ])
      ).rows[0].nsfwLevel;
    const consensus = (nsfwLevel: number) =>
      updateImageNsfwLevel({
        id: IMAGE_ID,
        nsfwLevel,
        userId: MOD,
        isModerator: true,
        activity: 'setNsfwLevelKono',
      } as never);

    it.each(MARKED)(
      'is skipped without throwing when the row carries %s, and returns the level it kept',
      async (_, row) => {
        await seed(row);

        await expect(consensus(NsfwLevel.PG13)).resolves.toBe(row.nsfwLevel);
        expect(await level()).toBe(row.nsfwLevel);
        expect(
          loggingMock.logToAxiom.mock.calls.filter(
            ([e]) => (e as { name?: string })?.name === 'rating-write-skipped-blocked'
          )
        ).toEqual([
          [
            {
              type: 'info',
              name: 'rating-write-skipped-blocked',
              imageId: IMAGE_ID,
              source: 'kono-consensus',
            },
          ],
        ]);
      }
    );

    it('re-blocking it to 32 is written', async () => {
      await seed(MARKED[0][1]);

      await consensus(NsfwLevel.Blocked);

      expect(await level()).toBe(NsfwLevel.Blocked);
    });

    it('control: an unmarked row takes the consensus', async () => {
      await seed(CLEAN);

      await consensus(NsfwLevel.PG13);

      expect(await level()).toBe(NsfwLevel.PG13);
    });
  });
});
