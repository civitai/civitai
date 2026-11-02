import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
// A signed-in reader's blocks and hidden users live outside these tables.
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
  HiddenUsers: { getCached: vi.fn().mockResolvedValue([]) },
}));

/**
 * The reading path and the canon line through a chapter where two branches rejoin, run as written
 * against an in-process Postgres built from the shipped storyline migrations. Which parent each
 * step takes, the order and the bound all live in the SQL, which a mocked client cannot see.
 */

const { getStorylinePath, getStorylineCanonAhead } = await import(
  '~/server/services/storyline.service'
);

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const r = dbMock.dbRead;

// Trunk 1 -> 2 -> 3; branch A 11 -> 12 and the longer branch B 21 -> 22 -> 23 -> 24 off 3. R (30)
// continues A's end, then 31 continues R. B's end is linked to R later, so A is R's oldest parent.
const R = 30;
const AFTER_R = 31;
const NODES: [id: number, depth: number][] = [
  [1, 0],
  [2, 1],
  [3, 2],
  [11, 3],
  [12, 4],
  [21, 3],
  [22, 4],
  [23, 5],
  [24, 6],
  [R, 5],
  [AFTER_R, 6],
];
const EDGES: [chapterId: number, parentChapterId: number, canon: boolean][] = [
  [2, 1, true],
  [3, 2, true],
  [11, 3, true],
  [12, 11, true],
  [21, 3, false],
  [22, 21, true],
  [23, 22, true],
  [24, 23, true],
  [R, 12, true],
  [AFTER_R, R, true],
];
const insertEdge = (chapterId: number, parentChapterId: number, canon: boolean, at: string) =>
  db.pg.query(
    `INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
     VALUES (1, $1, $2, $3, $4)`,
    [chapterId, parentChapterId, canon, at]
  );

let refusedBeforeMigration: unknown;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261024120000_storyline_chapter_removed',
  ])
    await db.pg.exec(migration(name));

  await db.pg.exec(`
    INSERT INTO "User" (id) VALUES (1);
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt")
      VALUES (1, 1, 'The Long Road', 1, now());
  `);
  for (const [id, depth] of NODES)
    await db.pg.query(
      `INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth) VALUES ($1, 1, 1, $2)`,
      [id, depth]
    );
  for (const [i, [chapterId, parentChapterId, canon]] of EDGES.entries())
    await insertEdge(chapterId, parentChapterId, canon, `2026-10-01T00:00:${10 + i}Z`);

  refusedBeforeMigration = await insertEdge(R, 24, true, '2026-10-02T00:00:00Z').catch(
    (e: unknown) => e
  );
  await db.pg.exec(migration('20261106120000_storyline_rejoin'));
  await insertEdge(R, 24, true, '2026-10-02T00:00:00Z');

  const raw = pgliteRaw(db.pg);
  r.$queryRaw.mockImplementation(raw.queryRaw as never);
  r.storylineChapter.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await db.pg.query(`SELECT "storylineId" FROM "StorylineChapter" WHERE id = $1`, [where.id]))
        .rows[0] ?? null) as never
  );
  // The joins' chapters. No chapter here has a post, so each reads as a 'deleted' tombstone.
  r.storylineChapter.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) =>
    (
      await db.pg.query<{ id: number }>(
        `SELECT id, depth, "removedAt" FROM "StorylineChapter" WHERE id = ANY($1::int[]) ORDER BY id`,
        [where.id.in]
      )
    ).rows.map((row) => ({ ...row, post: null }))) as never);
  r.post.findMany.mockResolvedValue([] as never);
  r.storylineChapterEdge.groupBy.mockImplementation((async ({
    by,
    where,
    _count,
  }: {
    by: string[];
    where: { parentChapterId: { in: number[] } };
    _count: unknown;
  }) => {
    // Only the call shape this SQL answers: child counts per parent.
    expect({ by, _count }).toEqual({ by: ['parentChapterId'], _count: { _all: true } });
    return (
      await db.pg.query<{ parentChapterId: number; n: number }>(
        `SELECT "parentChapterId", count(*)::int AS n FROM "StorylineChapterEdge"
         WHERE "parentChapterId" = ANY($1::int[]) GROUP BY 1`,
        [where.parentChapterId.in]
      )
    ).rows.map(({ parentChapterId, n }) => ({ parentChapterId, _count: { _all: n } }));
  }) as never);
  r.storyline.findUnique.mockResolvedValue({
    id: 1,
    userId: 1,
    title: 'The Long Road',
    status: 'Ongoing',
    whoCanContinue: 'Anyone',
    maxNsfwLevel: NsfwLevel.PG,
    minorByScan: false,
    tosViolation: false,
    nsfwLevel: 0,
    moderatorNsfwLevel: null,
    createdAt: new Date('2026-10-01'),
    user: { id: 1, username: 'owner', bannedAt: null, deletedAt: null },
    chapters: [
      {
        id: 1,
        postId: null,
        removedAt: null,
        post: {
          nsfwLevel: NsfwLevel.PG,
          publishedAt: new Date(0),
          tosViolation: false,
          user: { bannedAt: null, deletedAt: null },
        },
      },
    ],
  } as never);
});

afterAll(async () => {
  await db.pg.close();
});

const read = (chapterId: number, via?: number[]) =>
  getStorylinePath({ chapterId, via, viewer: undefined, browsingLevel: NsfwLevel.PG });
const route = (chapters: { chapterId: number; depth: number }[]) =>
  chapters.map((c) => [c.chapterId, c.depth]);
const joinsAt = (chapters: { chapterId: number; joins: { chapterId: number }[] }[]) =>
  chapters.flatMap((c) => (c.joins.length ? [[c.chapterId, c.joins.map((j) => j.chapterId)]] : []));

describe('the rejoin migration', () => {
  it('lifts the one-parent rule, and only that', async () => {
    expect((refusedBeforeMigration as Error).message).toMatch(
      /StorylineChapterEdge_single_parent_key/
    );
    const parents = await db.pg.query(
      `SELECT "parentChapterId" FROM "StorylineChapterEdge" WHERE "chapterId" = $1 ORDER BY 1`,
      [R]
    );
    expect(parents.rows).toEqual([{ parentChapterId: 12 }, { parentChapterId: 24 }]);
    await expect(insertEdge(R, 24, false, '2026-10-03T00:00:00Z')).rejects.toThrow(
      /StorylineChapterEdge_pkey/
    );
  });
});

describe('getStorylinePath through a rejoin', () => {
  it("takes the chapter's oldest link when the reader's way in is not given", async () => {
    const { chapters, hasEarlier } = await read(AFTER_R);
    expect(route(chapters)).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [11, 3],
      [12, 4],
      [R, 5],
      [AFTER_R, 6],
    ]);
    expect(joinsAt(chapters)).toEqual([[R, [24]]]);
    expect(hasEarlier).toBe(false);
  });

  it('follows the way the reader came, numbering each chapter by its place on that route', async () => {
    const { chapters, hasEarlier } = await read(AFTER_R, [24]);
    // Nine chapters to one whose first-parent depth is 6: the whole route, from chapter 1.
    expect(route(chapters)).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [21, 3],
      [22, 4],
      [23, 5],
      [24, 6],
      [R, 7],
      [AFTER_R, 8],
    ]);
    expect(joinsAt(chapters)).toEqual([[R, [12]]]);
    expect(hasEarlier).toBe(false);
    expect(chapters.find((c) => c.chapterId === R)?.parentCount).toBe(2);
  });

  it('counts the ways on from each chapter, so the rail can mark where other paths leave', async () => {
    const { chapters } = await read(AFTER_R, [24]);
    const childCounts = chapters.map((c) => [c.chapterId, c.childCount]);
    expect(childCounts).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
      [21, 1],
      [22, 1],
      [23, 1],
      [24, 1],
      [R, 1],
      [AFTER_R, 0],
    ]);
  });

  it('ignores a way in that is on no route to the chapter', async () => {
    const { chapters } = await read(AFTER_R, [22, 999]);
    expect(route(chapters).map(([id]) => id)).toEqual([1, 2, 3, 11, 12, R, AFTER_R]);
  });

  it('stops at a chapter it has already passed, so a corrupt loop cannot run on', async () => {
    await insertEdge(1, AFTER_R, false, '2026-10-04T00:00:00Z');
    try {
      const { chapters } = await read(AFTER_R);
      expect(route(chapters).map(([id]) => id)).toEqual([1, 2, 3, 11, 12, R, AFTER_R]);
    } finally {
      await db.pg.query(`DELETE FROM "StorylineChapterEdge" WHERE "chapterId" = 1`);
    }
  });
});

describe('getStorylineCanonAhead into a rejoin', () => {
  it('runs on through the rejoined chapter, in route order, marking where the other branch joins', async () => {
    const ahead = await getStorylineCanonAhead({
      chapterId: 22,
      viewer: undefined,
      browsingLevel: NsfwLevel.PG,
    });
    expect(ahead.map((c) => c.chapterId)).toEqual([23, 24, R, AFTER_R]);
    expect(joinsAt(ahead)).toEqual([[R, [12]]]);
  });
});

describe('getStorylinePath marks the owner’s main route', () => {
  const onMain = (chapters: { chapterId: number; onMain: boolean }[]) =>
    chapters.map((c) => [c.chapterId, c.onMain]);

  it('flags the chapters on the canon route from chapter 1, and none of a branch', async () => {
    const { chapters } = await read(AFTER_R, [24]);
    expect(onMain(chapters)).toEqual([
      [1, true],
      [2, true],
      [3, true],
      // Branch B: 21 is reached by a non-canon link, and its own canon children inherit nothing.
      [21, false],
      [22, false],
      [23, false],
      [24, false],
      // R is on the main route by A's end, however the reader came to it.
      [R, true],
      [AFTER_R, true],
    ]);
  });

  it('agrees with the canon route the main path reads', async () => {
    const mainRoute = [
      1,
      ...(
        await getStorylineCanonAhead({
          chapterId: 1,
          viewer: undefined,
          browsingLevel: NsfwLevel.PG,
        })
      ).map((c) => c.chapterId),
    ];
    expect(mainRoute).toEqual([1, 2, 3, 11, 12, R, AFTER_R]);
    for (const via of [undefined, [24]]) {
      const { chapters } = await read(AFTER_R, via);
      expect(chapters.map((c) => c.onMain)).toEqual(
        chapters.map((c) => mainRoute.includes(c.chapterId))
      );
    }
  });

  it('flags nothing for a storyline with no first chapter, rather than failing the read', async () => {
    const found = await r.storyline.findUnique({ where: { id: 1 } } as never);
    r.storyline.findUnique.mockResolvedValueOnce({ ...found, chapters: [] } as never);
    // Only its owner and moderators can read a storyline with no first chapter.
    const { chapters } = await getStorylinePath({
      chapterId: 3,
      viewer: { id: 1 },
      browsingLevel: NsfwLevel.PG,
    });
    expect(chapters.map((c) => c.onMain)).toEqual([false, false, false]);
  });
});

describe('getStorylinePath on a line longer than its window', () => {
  // A 260-chapter line, 1000 (depth 0) to 1259. Chapter 1005 is also continued from the end of a
  // short branch, so it has two parents: far outside the 200 chapters nearest the end. Chapter 1200
  // is likewise continued from a branch, inside that window.
  const FIRST = 1000;
  const END = 1259;
  const EARLY = 1005;
  const EARLY_BRANCH_END = 2002;
  const LATE = 1200;
  const LATE_BRANCH_END = 3002;

  // Its own storyline: a storyline has one first chapter.
  const edge2 = (chapterId: number, parentChapterId: number, canon: boolean, at: string) =>
    db.pg.query(
      `INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
       VALUES (2, $1, $2, $3, $4)`,
      [chapterId, parentChapterId, canon, at]
    );

  beforeAll(async () => {
    await db.pg.exec(`
      INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt")
        VALUES (2, 1, 'The Longer Road', 1, now());
      INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth)
        SELECT ${FIRST} + n, 2, 1, n FROM generate_series(0, ${END - FIRST}) AS n;
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
        SELECT 2, ${FIRST} + n, ${FIRST} + n - 1, true, '2026-11-01T00:00:00Z'::timestamptz + n * interval '1 second'
        FROM generate_series(1, ${END - FIRST}) AS n;
      INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth) VALUES
        (2001, 2, 1, 1), (${EARLY_BRANCH_END}, 2, 1, 2), (3001, 2, 1, 191), (${LATE_BRANCH_END}, 2, 1, 192);
    `);
    await edge2(2001, FIRST, false, '2026-11-02T00:00:00Z');
    await edge2(EARLY_BRANCH_END, 2001, true, '2026-11-02T00:00:01Z');
    await edge2(EARLY, EARLY_BRANCH_END, true, '2026-11-02T00:00:02Z');
    await edge2(3001, 1190, false, '2026-11-02T00:00:03Z');
    await edge2(LATE_BRANCH_END, 3001, true, '2026-11-02T00:00:04Z');
    await edge2(LATE, LATE_BRANCH_END, true, '2026-11-02T00:00:05Z');
  });

  it('is the same window whether or not the reader came by a rejoin beyond it', async () => {
    const plain = await read(END);
    const viaEarly = await read(END, [EARLY_BRANCH_END]);
    expect(plain.chapters).toHaveLength(200);
    expect(plain.hasEarlier).toBe(true);
    expect(route(viaEarly.chapters)).toEqual(route(plain.chapters));
    expect(viaEarly.hasEarlier).toBe(true);
  });

  // Without this the test above could pass for a window a way in can never change.
  it('is a different route when the rejoin is inside the window', async () => {
    const plain = await read(END);
    const viaLate = await read(END, [LATE_BRANCH_END]);
    expect(route(viaLate.chapters)).not.toEqual(route(plain.chapters));
    expect(viaLate.chapters.some((c) => c.chapterId === LATE_BRANCH_END)).toBe(true);
    expect(plain.chapters.some((c) => c.chapterId === LATE_BRANCH_END)).toBe(false);
  });
});

describe('lockLiveChapters', () => {
  it('names the live chapters among those asked for, in id order, and leaves out a removed one', async () => {
    await db.pg.query(
      `INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "removedAt") VALUES (4000, 2, 1, 1, now())`
    );
    const { lockLiveChapters } = await import('~/server/services/storyline.service');
    // Stored out of id order, so only the ORDER BY puts them in it.
    await db.pg.query(
      `INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth) VALUES (4002, 2, 1, 1), (4001, 2, 1, 1)`
    );
    const live = await lockLiveChapters(
      dbMock.dbRead as never,
      [4002, 1003, 4000, 999999, 4001, 1001]
    );
    expect(live).toEqual([1001, 1003, 4001, 4002]);
  });
});
