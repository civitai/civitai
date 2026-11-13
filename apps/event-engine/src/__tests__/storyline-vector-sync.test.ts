import { describe, expect, test } from 'vitest';
import { nextRefreshIds } from '@/vector-sync/domain/refresh';
import { storylineDomain, storylineRefFromEvent } from '@/vector-sync/storylines/domain';
import { getStorylineDocs } from '@/vector-sync/storylines/source';
import { contentRoute, selectDomains } from '@/vector-sync/content/consumer';

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp,
    "deletedAt" timestamp);
  CREATE TABLE "Storyline" (id int PRIMARY KEY, title text, status text, "whoCanContinue" text,
    "userId" int, "tosViolation" boolean, "maxNsfwLevel" int, "nsfwLevel" int,
    "moderatorNsfwLevel" int, "coverImageId" int);
  CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int, title text, detail text,
    "tosViolation" boolean, "nsfwLevel" int, "publishedAt" timestamp, availability text);
  CREATE TABLE "StorylineChapter" (id int PRIMARY KEY, "storylineId" int, "postId" int,
    depth int, "removedAt" timestamp);
`;

// Eligibility and the story level are pinned to the site's by its storyline-eligibility parity test.
describe('storyline payload, against the real query', () => {
  test("carries the filter fields and chapter 1's opening, read at depth 0", async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`${SCHEMA}
      INSERT INTO "User" VALUES (7, 'someone', NULL, NULL);
      INSERT INTO "Storyline" VALUES
        (1, 'The  Long Road', 'Ongoing', 'Anyone', 7, false, 16, 4, NULL, 70),
        (2, 'No chapter one', 'Ongoing', 'Anyone', 7, false, 16, 0, NULL, NULL);
      INSERT INTO "Post" VALUES
        (10, 7, 'Dawn', '<p>She <b>left</b> at dawn</p>', false, 1, '2026-01-01', 'Public'),
        (11, 7, 'Later', 'Not the opening', false, 1, '2026-01-02', 'Public');
      INSERT INTO "StorylineChapter" VALUES (100, 1, 10, 0, NULL), (101, 1, 11, 1, NULL);
    `);
    try {
      const docs = await getStorylineDocs(
        pg as unknown as Parameters<typeof getStorylineDocs>[0],
        [1, 2]
      );
      expect([...docs.keys()]).toEqual([1]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'the long road',
        title: 'The  Long Road',
        status: 'Ongoing',
        whoCanContinue: 'Anyone',
        // Chapter 1 at PG, raised to the title's PG-13.
        nsfwLevel: [4],
        rootPublishedAt: '2026-01-01T00:00:00.000Z',
        rootChapterId: 100,
        userId: 7,
        username: 'someone',
        coverImageId: 70,
      });
      expect(docs.get(1)?.search_text).toBe(
        'Title: The Long Road\nCreator: someone\nOpening: Dawn. She left at dawn'
      );
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('storyline change signals', () => {
  test('a storyline or chapter change names the storyline', () => {
    expect(storylineRefFromEvent('postgres.Storyline', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      storylineRefFromEvent('postgres.StorylineChapter', {
        op: 'u',
        after: { id: 40, storylineId: 4, postId: null },
      })
    ).toEqual({ id: 4 });
    expect(storylineRefFromEvent('postgres.Storyline', { op: 'r', after: { id: 5 } })).toBeNull();
  });

  test('a chapter delete that carries only its id is resolved through rootChapterId', () => {
    expect(
      storylineRefFromEvent('postgres.StorylineChapter', {
        op: 'd',
        before: { id: 41 },
        after: null,
      })
    ).toEqual({ child: 41 });
    expect(storylineDomain.childField).toBe('rootChapterId');
    const route = contentRoute(selectDomains(['storyline']));
    expect(route('postgres.StorylineChapter', { op: 'd', before: { id: 41 } })).toEqual([
      ['storyline', { child: 41 }],
    ]);
  });
});

describe('storyline refresh walk', () => {
  test('walks every storyline by keyset, in batches, and wraps at the end', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`CREATE TABLE "Storyline" (id int PRIMARY KEY);
      INSERT INTO "Storyline" SELECT g FROM generate_series(1, 5) g;`);
    try {
      const db = pg as unknown as Parameters<typeof nextRefreshIds>[0];
      const seen: number[][] = [];
      let cursor = 0;
      for (let i = 0; i < 4; i++) {
        const { ids, next } = await nextRefreshIds(db, storylineDomain, cursor, 2);
        seen.push(ids);
        cursor = next;
      }
      expect(seen).toEqual([[1, 2], [3, 4], [5], [1, 2]]);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('runs at the spec interval and batch', () => {
    expect(storylineDomain.refresh).toEqual({ everyMs: 15 * 60_000, batch: 500 });
  });
});

describe('storyline embedding switch', () => {
  test('stays off until VECTOR_STORYLINE_EMBED_ENABLED is true, even with the global switch on', async () => {
    const { config, domainEmbedEnabled } = await import('@/config');
    const global = config.vectorSync.embedEnabled;
    const own = process.env.VECTOR_STORYLINE_EMBED_ENABLED;
    try {
      config.vectorSync.embedEnabled = true;
      delete process.env.VECTOR_STORYLINE_EMBED_ENABLED;
      expect(domainEmbedEnabled(storylineDomain.name, storylineDomain.embedByDefault)).toBe(false);
      process.env.VECTOR_STORYLINE_EMBED_ENABLED = 'true';
      expect(domainEmbedEnabled(storylineDomain.name, storylineDomain.embedByDefault)).toBe(true);
    } finally {
      config.vectorSync.embedEnabled = global;
      if (own === undefined) delete process.env.VECTOR_STORYLINE_EMBED_ENABLED;
      else process.env.VECTOR_STORYLINE_EMBED_ENABLED = own;
    }
  });
});
