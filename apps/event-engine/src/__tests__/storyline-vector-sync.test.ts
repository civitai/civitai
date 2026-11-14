import { describe, expect, test } from 'vitest';
import { nextRefreshIds } from '@/vector-sync/domain/refresh';
import { storylineDomain, storylineRefFromEvent } from '@/vector-sync/storylines/domain';
import { getStorylineDocs, type StorylinePayload } from '@/vector-sync/storylines/source';
import { syncIds } from '@/vector-sync/domain/sync';
import type { EmbedInput } from '@/vector-sync/embedder';
import { contentRoute, selectDomains } from '@/vector-sync/content/consumer';

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp,
    "deletedAt" timestamp);
  CREATE TABLE "Storyline" (id int PRIMARY KEY, title text, status text, "whoCanContinue" text,
    "userId" int, "tosViolation" boolean, "maxNsfwLevel" int, "nsfwLevel" int,
    "moderatorNsfwLevel" int, "coverImageId" int, "minorByScan" boolean NOT NULL DEFAULT false);
  CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int, title text, detail text,
    "tosViolation" boolean, "nsfwLevel" int, "publishedAt" timestamp, availability text);
  CREATE TABLE "StorylineChapter" (id int PRIMARY KEY, "storylineId" int, "postId" int,
    depth int, "removedAt" timestamp);
  CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "postId" int, "needsReview" text,
    "blockedFor" text);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "EvidenceHeldUser" ("userId" int);
  CREATE TABLE "PostText" (id serial PRIMARY KEY, "postId" int, "csamHeld" boolean NOT NULL);
  CREATE TABLE "TextScanHold" (id serial PRIMARY KEY, "entityType" text, "entityId" int,
    label text, status text);
`;

/** Storyline `id` owned by `owner`, chapter 1 = post `id * 10` with image `id * 100`. */
const eligibleStoryline = (id: number, owner = 7) => `
  INSERT INTO "Storyline" VALUES (${id}, 'Story ${id}', 'Ongoing', 'Anyone', ${owner}, false, 16, 0,
    NULL, NULL);
  INSERT INTO "Post" VALUES (${id * 10}, ${owner}, 'Opening ${id}', NULL, false, 1, '2026-01-01',
    'Public');
  INSERT INTO "StorylineChapter" VALUES (${id * 10}, ${id}, ${id * 10}, 0, NULL);
  INSERT INTO "Image" VALUES (${id * 100}, ${owner}, ${id * 10}, NULL, NULL);`;

/** A Qdrant and embedder stand-in: the points, and every input the embedder was sent. */
function fakes(pg: unknown) {
  const points = new Map<number, StorylinePayload>();
  const sent: EmbedInput[] = [];
  const store = {
    payloadFields: async (ids: number[]) =>
      new Map(ids.flatMap((id) => (points.has(id) ? [[id, points.get(id)!] as const] : []))),
    delete: async (ids: number[]) => ids.forEach((id) => points.delete(id)),
    setPayloads: async (p: Map<number, StorylinePayload>) =>
      p.forEach((payload, id) => points.set(id, payload)),
    upsert: async (ps: { id: number; payload: StorylinePayload }[]) =>
      ps.forEach((p) => points.set(p.id, p.payload)),
    assertModel: async () => undefined,
  };
  const embedder = {
    embed: async (
      inputs: EmbedInput[],
      o: { onVectors?: (v: Map<number, number[]>) => Promise<void> } = {}
    ) => {
      sent.push(...inputs);
      const vectors = new Map(inputs.map((i) => [Number(i.id), [1]]));
      await o.onVectors?.(vectors);
      return { vectors, failed: [], stamp: undefined };
    },
  };
  return { points, sent, deps: { pg, store, embedder } as never };
}

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

describe("chapter 1's text above the storyline's ceiling", () => {
  test('is left out of the document, as readers get a tombstone', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    // 1: within its ceiling. 2: chapter 1 at X under an R ceiling. 3: chapter 1 at R under an X
    // ceiling the title scan lowered to the minor ceiling.
    await pg.exec(`${SCHEMA}
      INSERT INTO "User" VALUES (7, 'someone', NULL, NULL);
      INSERT INTO "Storyline" VALUES
        (1, 'Shown', 'Ongoing', 'Anyone', 7, false, 16, 0, NULL, NULL, false),
        (2, 'Over', 'Ongoing', 'Anyone', 7, false, 4, 0, NULL, NULL, false),
        (3, 'Minor', 'Ongoing', 'Anyone', 7, false, 16, 0, NULL, NULL, true);
      INSERT INTO "Post" VALUES
        (10, 7, 'Dawn', 'She left', false, 1, '2026-01-01', 'Public'),
        (20, 7, 'Dusk', 'She came back', false, 16, '2026-01-01', 'Public'),
        (30, 7, 'Noon', 'She stayed', false, 4, '2026-01-01', 'Public');
      INSERT INTO "StorylineChapter" VALUES (10, 1, 10, 0, NULL), (20, 2, 20, 0, NULL),
        (30, 3, 30, 0, NULL);
    `);
    try {
      const docs = await getStorylineDocs(
        pg as unknown as Parameters<typeof getStorylineDocs>[0],
        [1, 2, 3]
      );
      expect(docs.get(1)?.search_text).toBe(
        'Title: Shown\nCreator: someone\nOpening: Dawn. She left'
      );
      expect(docs.get(2)?.search_text).toBe('Title: Over\nCreator: someone\nOpening: ');
      expect(docs.get(3)?.search_text).toBe('Title: Minor\nCreator: someone\nOpening: ');
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('storyline removal', () => {
  // Each change takes indexed storyline 1 out of eligibility; the next sync of its id deletes the
  // point. Storyline 2 (another owner) is the control and keeps its point.
  const leaves: [string, string][] = [
    ['taken down', `UPDATE "Storyline" SET "tosViolation" = true WHERE id = 1`],
    ['owner banned', `UPDATE "User" SET "bannedAt" = now() WHERE id = 7`],
    ['owner deleted', `UPDATE "User" SET "deletedAt" = now() WHERE id = 7`],
    ['owner reported', `INSERT INTO "CsamReport" ("userId") VALUES (7)`],
    ['owner under an evidence hold', `INSERT INTO "EvidenceHeldUser" VALUES (7)`],
    ['chapter 1 removed', `UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 10`],
    ['chapter 1 post deleted', `UPDATE "StorylineChapter" SET "postId" = NULL WHERE id = 10`],
    ['chapter 1 post taken down', `UPDATE "Post" SET "tosViolation" = true WHERE id = 10`],
    ['chapter 1 post blocked', `UPDATE "Post" SET "nsfwLevel" = 32 WHERE id = 10`],
    ['chapter 1 image in CSAM review', `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 100`],
    ['chapter 1 image blocked for CSAM', `UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = 100`],
    ['chapter 1 image listed on a report', `INSERT INTO "CsamReport" (images) VALUES ('[100]')`],
    ['chapter 1 text item held', `INSERT INTO "PostText" ("postId", "csamHeld") VALUES (10, true)`],
    [
      'chapter 1 text item pending a hold',
      `INSERT INTO "PostText" (id, "postId", "csamHeld") VALUES (500, 10, false);
       INSERT INTO "TextScanHold" ("entityType", "entityId", label, status)
       VALUES ('PostText', 500, 'csam', 'Pending')`,
    ],
  ];
  test.each(leaves)(
    'a storyline whose %s loses its point on the next sync',
    async (_, change) => {
      const { PGlite } = await import('@electric-sql/pglite');
      const pg = new PGlite();
      try {
        await pg.exec(`${SCHEMA}
        INSERT INTO "User" VALUES (7, 'someone', NULL, NULL), (8, 'other', NULL, NULL);
        ${eligibleStoryline(1)} ${eligibleStoryline(2, 8)}`);
        const { points, deps } = fakes(pg);
        await syncIds(getStorylineDocs, [1, 2], deps);
        expect([...points.keys()].sort()).toEqual([1, 2]);

        await pg.exec(change);
        const stats = await syncIds(getStorylineDocs, [1, 2], deps);
        expect([...points.keys()]).toEqual([2]);
        expect(stats.deleted).toBe(1);
      } finally {
        await pg.close();
      }
    },
    60_000
  );

  test('a storyline with a held chapter 1 image is never embedded', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    try {
      await pg.exec(`${SCHEMA}
        INSERT INTO "User" VALUES (7, 'someone', NULL, NULL), (8, 'other', NULL, NULL);
        ${eligibleStoryline(1)} ${eligibleStoryline(2, 8)}
        UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 200;`);
      const { points, sent, deps } = fakes(pg);
      await syncIds(getStorylineDocs, [1, 2], deps);
      expect([...points.keys()]).toEqual([1]);
      expect(sent.map((i) => i.id)).toEqual(['1']);
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
