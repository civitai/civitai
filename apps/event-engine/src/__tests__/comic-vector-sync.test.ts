import { describe, expect, test } from 'vitest';
import { comicDomain, comicRefFromEvent } from '@/vector-sync/comics/domain';
import { getComicDocs } from '@/vector-sync/comics/source';
import { contentRoute, OUTBOX_TOPIC, selectDomains } from '@/vector-sync/content/consumer';

// Eligibility itself is pinned to the site's rule by the site's comic-eligibility parity test.
describe('comic payload, against the real query', () => {
  test('carries the fields the site filters on, nsfwLevel kept whole', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "ComicGenre" AS ENUM ('Action', 'Fantasy');
      CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp);
      CREATE TABLE "ComicProject" (id int PRIMARY KEY, name text, description text,
        genre "ComicGenre", "nsfwLevel" int, "updatedAt" timestamp, "userId" int,
        "coverImageId" int, status text, "tosViolation" boolean);
      CREATE TABLE "ComicChapter" ("projectId" int, position int, status text);
      CREATE TABLE "Image" (id int PRIMARY KEY, ingestion text, "needsReview" text,
        "tosViolation" boolean);
      CREATE TABLE "ComicPanel" ("projectId" int, "chapterPosition" int, "imageId" int,
        "imageUrl" text, status text);
      INSERT INTO "User" VALUES (7, 'someone', NULL);
      INSERT INTO "ComicProject" VALUES (1, 'Sky  Knights', '<p>Two <b>pilots</b></p>', 'Fantasy',
        5, '2026-01-01', 7, 70, 'Active', false), (2, 'Unpublished', NULL, NULL, 0, '2026-01-01',
        7, NULL, 'Active', false);
      INSERT INTO "ComicChapter" VALUES (1, 1, 'Published'), (2, 1, 'Draft');
      INSERT INTO "Image" VALUES (10, 'Scanned', NULL, false), (20, 'Scanned', NULL, false);
      INSERT INTO "ComicPanel" VALUES (1, 1, 10, 'u', 'Ready'), (2, 1, 20, 'u', 'Ready');
    `);
    try {
      const docs = await getComicDocs(pg as unknown as Parameters<typeof getComicDocs>[0], [1, 2]);
      expect([...docs.keys()]).toEqual([1]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'sky knights',
        name: 'Sky  Knights',
        genre: 'Fantasy',
        nsfwLevel: 5,
        updatedAt: '2026-01-01T00:00:00.000Z',
        userId: 7,
        username: 'someone',
        coverImageId: 70,
      });
      expect(docs.get(1)?.search_text).toBe(
        'Name: Sky Knights\nCreator: someone\nGenre: Fantasy\nDescription: Two pilots'
      );
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('comic change signals', () => {
  test('a project or chapter change names the comic; a chapter delete names it too', () => {
    expect(comicRefFromEvent('postgres.ComicProject', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      comicRefFromEvent('postgres.ComicChapter', {
        op: 'd',
        before: { projectId: 4, position: 2 },
        after: null,
      })
    ).toEqual({ id: 4 });
    expect(comicRefFromEvent('postgres.ComicProject', { op: 'r', after: { id: 5 } })).toBeNull();
  });

  test("the site's search.update rows for comics reach the comic domain", () => {
    const route = contentRoute(selectDomains(['comic']));
    const outbox = (entityType: string) => ({
      op: 'c',
      after: { event: 'search.update', entityType, entityId: '9' },
    });
    expect(route(OUTBOX_TOPIC, outbox('Comic'))).toEqual([['comic', { id: 9 }]]);
    expect(route(OUTBOX_TOPIC, outbox('Article'))).toEqual([]);
  });
});

describe('comic embedding switch', () => {
  test('stays off until VECTOR_COMIC_EMBED_ENABLED is true, even with the global switch on', async () => {
    const { config, domainEmbedEnabled } = await import('@/config');
    const global = config.vectorSync.embedEnabled;
    const own = process.env.VECTOR_COMIC_EMBED_ENABLED;
    try {
      config.vectorSync.embedEnabled = true;
      delete process.env.VECTOR_COMIC_EMBED_ENABLED;
      expect(domainEmbedEnabled(comicDomain.name, comicDomain.embedByDefault)).toBe(false);
      process.env.VECTOR_COMIC_EMBED_ENABLED = 'true';
      expect(domainEmbedEnabled(comicDomain.name, comicDomain.embedByDefault)).toBe(true);
    } finally {
      config.vectorSync.embedEnabled = global;
      if (own === undefined) delete process.env.VECTOR_COMIC_EMBED_ENABLED;
      else process.env.VECTOR_COMIC_EMBED_ENABLED = own;
    }
  });
});
