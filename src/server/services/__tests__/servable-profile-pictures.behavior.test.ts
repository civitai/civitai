import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as RedisCaches from '~/server/redis/caches';

/**
 * Article cards and the bounty, collection and comic search documents carry an author's profile
 * picture only when it may be served.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
  articleStatCache: { fetch: vi.fn().mockResolvedValue({}) },
}));
vi.mock('~/server/services/system-cache', () => ({
  getCategoryTags: vi.fn().mockResolvedValue([]),
  getSystemTags: vi.fn().mockResolvedValue([]),
}));

const { getServableProfilePictures, servableProfilePictureSql } = await import(
  '~/server/services/profile-picture.sql'
);
const { bountiesSearchIndex, transformData: transformBounties } = await import(
  '~/server/search-index/bounties.search-index'
);
const { comicsSearchIndex } = await import('~/server/search-index/comics.search-index');
const { pullData: pullCollections, transformData: transformCollections } = await import(
  '~/server/search-index/collections.search-index'
);
const { getArticles } = await import('~/server/services/article.service');
const { ArticleSort } = await import('~/server/common/enums');
const { MetricTimeframe } = await import('~/shared/utils/prisma/enums');

const CLEAN = 10;
const BLOCKED = 20;
const FLAGGED = 30;
const CLEAN_AUTHOR = 1;
const BLOCKED_AUTHOR = 2;
const FLAGGED_AUTHOR = 3;

let pg: PGlite;
const runOnPg = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = Prisma.sql(strings, ...(values as never[]));
  return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
};
const pgClient = { $queryRaw: runOnPg } as never;
// The servable-picture read, told apart by its first clause: the whole fragment's text cannot be
// matched, because its nested placeholders are renumbered where it is embedded.
const isServablePictureRead = (text: string) =>
  text.includes(servableProfilePictureSql.text.trim().split('\n')[0].trim());

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1,
      hash text, "userId" int NOT NULL, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text, type "MediaType" NOT NULL DEFAULT 'image', width int, height int, metadata jsonb,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb
    );
    INSERT INTO "Image" (id, url, "userId", ingestion, "needsReview") VALUES
      (${CLEAN}, 'clean', ${CLEAN_AUTHOR}, 'Scanned', NULL),
      (${BLOCKED}, 'blocked', ${BLOCKED_AUTHOR}, 'Blocked', NULL),
      (${FLAGGED}, 'flagged', ${FLAGGED_AUTHOR}, 'Scanned', 'csam'),
      (40, 'pending', 4, 'Pending', NULL),
      (50, 'other-review', 5, 'Scanned', 'other-review'),
      (60, 'error', 6, 'Error', NULL);
    INSERT INTO "Image" (id, url, "userId", ingestion, "nsfwLevelLocked") VALUES
      (70, 'pending-mod-rated', 7, 'Pending', true);
  `);
});
afterAll(() => pg.close());

const picture = (id: number, url: string, userId: number) => ({
  id,
  name: null,
  url,
  nsfwLevel: 1,
  hash: null,
  userId,
  ingestion: 'Scanned',
  type: 'image',
  width: null,
  height: null,
  metadata: null,
});
// What an unfiltered read by id returns for the three authors.
const unfilteredPictures = [
  picture(CLEAN, 'clean', CLEAN_AUTHOR),
  { ...picture(BLOCKED, 'blocked', BLOCKED_AUTHOR), ingestion: 'Blocked' },
  picture(FLAGGED, 'flagged', FLAGGED_AUTHOR),
];

const author = (id: number, profilePictureId: number) => ({
  id,
  username: `u${id}`,
  image: null,
  deletedAt: null,
  profilePictureId,
});
const authors = [
  author(CLEAN_AUTHOR, CLEAN),
  author(BLOCKED_AUTHOR, BLOCKED),
  author(FLAGGED_AUTHOR, FLAGGED),
];

/**
 * A search-index context whose record query returns `rows`. The servable-picture read runs on
 * pglite, and an unfiltered `image.findMany` returns every author's picture.
 */
const indexDb = (rows: unknown[]) => ({
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    if (isServablePictureRead(sql.text)) return runOnPg(strings, ...values);
    return Promise.resolve(rows);
  },
  image: { findMany: async () => unfilteredPictures },
});
const ctx = (rows: unknown[]) => ({ db: indexDb(rows), logger: () => undefined } as never);
const batch = { type: 'update', ids: [1, 2, 3] } as never;

const pictureUrls = (pictures: { url: string }[]) => pictures.map((p) => p.url).sort();

describe('servable profile pictures', () => {
  it('leaves out pictures that may not be served and keeps the rest', async () => {
    const pictures = await getServableProfilePictures(pgClient, [
      CLEAN,
      BLOCKED,
      FLAGGED,
      40,
      50,
      60,
      70,
    ]);

    // Unscanned pictures (Pending, Error) are left out; a moderator's rating stands in for a scan.
    expect(pictureUrls(pictures)).toEqual(['clean', 'other-review', 'pending-mod-rated']);
  });

  it('bounty search docs carry no author picture that may not be served', async () => {
    const bounties = authors.map((user, i) => ({
      id: i + 1,
      user,
      cosmetics: [],
      tags: [],
      images: [{ id: 100 + i }],
      nsfwLevel: 1,
      stats: null,
    }));
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);

    const data = await bountiesSearchIndex.pullData(ctx(bounties), batch);
    const docs = await transformBounties(data as never);

    expect(docs.map((d) => d.user.profilePicture?.url ?? null)).toEqual(['clean', null, null]);
  });

  it('collection search docs carry no author picture that may not be served', async () => {
    const collections = authors.map((user, i) => ({
      id: i + 1,
      user,
      cosmetics: [],
      image: { id: 200 + i },
      metrics: null,
      nsfwLevel: 1,
    }));

    const data = await pullCollections(ctx(collections), batch);
    const { records: docs } = await transformCollections(data as never);

    expect(docs.map((d) => d.user.profilePicture?.url ?? null)).toEqual(['clean', null, null]);
  });

  it('comic search data carries no author picture that may not be served', async () => {
    const comics = authors.map((user, i) => ({ id: i + 1, user, nsfwLevel: 1 }));

    const data = (await comicsSearchIndex.pullData(ctx(comics), batch)) as {
      profilePictures: { url: string }[];
    };

    expect(pictureUrls(data.profilePictures)).toEqual(['clean']);
  });

  describe('article cards', () => {
    const articleRows = () =>
      authors.map((user, i) => ({
        id: i + 1,
        userId: user.id,
        user,
        tags: [],
        userCosmetics: [],
        cursorV: 0,
        availability: 'Public',
        coverId: null,
        nsfwLevel: 1,
      }));

    beforeEach(() => {
      dbMock.dbRead.$queryRaw.mockImplementation(((
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const sql = Prisma.sql(strings, ...(values as never[]));
        if (isServablePictureRead(sql.text)) return runOnPg(strings, ...values);
        return Promise.resolve(articleRows());
      }) as never);
      dbMock.dbRead.image.findMany.mockResolvedValue(unfilteredPictures as never);
    });

    it('carry no author picture that may not be served', async () => {
      const { items } = await getArticles({
        limit: 10,
        sort: ArticleSort.Newest,
        period: MetricTimeframe.AllTime,
        periodMode: 'published',
        browsingLevel: 1,
      } as Parameters<typeof getArticles>[0]);

      expect(items.map((a) => a.user.profilePicture?.url ?? null)).toEqual(['clean', null, null]);
    });
  });
});
