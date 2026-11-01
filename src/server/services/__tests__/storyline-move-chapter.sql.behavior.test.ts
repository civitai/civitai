import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { REDIS_KEYS } from '~/server/redis/client';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

const { trackModActivity } = vi.hoisted(() => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustFetchThroughCache: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Moving a chapter within a run of the owner's own chapters, run as written against an in-process
 * Postgres built from the shipped storyline migrations: the rewire, the depths and the moved
 * branch choices all live in SQL, which a mocked client cannot see.
 *
 * PGlite has one session, so nothing here interleaves two transactions. The move's storyline
 * lock against a chapter add was checked once against a real Postgres (see the PR).
 */

const { canonRouteWalk, moveStorylineChapter } = await import(
  '~/server/services/storyline.service'
);
const { bustFetchThroughCache } = await import('~/server/utils/cache-helpers');

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const w = dbMock.dbWrite;

const OWNER = 1;
const CONTRIBUTOR = 2;
const READER = 3;

// The owner's run 1 -> 2 -> 3 -> 4 -> 5 -> 6, all canon, 6 the last chapter.
const RUN = [1, 2, 3, 4, 5, 6];

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;

let edgeSecond = 10;
const addChapter = async (
  id: number,
  parentChapterId: number,
  depth: number,
  { canon = true, placementId = null as number | null } = {}
) => {
  await db.pg.query(
    `INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "placementId")
     VALUES ($1, 1, $2, $3, $4)`,
    [id, placementId ? CONTRIBUTOR : OWNER, depth, placementId]
  );
  await addEdge(id, parentChapterId, canon);
};
const addEdge = (chapterId: number, parentChapterId: number, canon: boolean) =>
  db.pg.query(
    `INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
     VALUES (1, $1, $2, $3, $4)`,
    [chapterId, parentChapterId, canon, `2026-10-01T00:00:${edgeSecond++}Z`]
  );
// 6 forks into 7 (canon) and 8; 7 is continued by a contributor's chapter, 9.
const forkAfterRun = async () => {
  await addChapter(7, 6, 6);
  await addChapter(8, 6, 6, { canon: false });
  await addChapter(9, 7, 7, { placementId: 900 });
};

const move = (
  chapterId: number,
  afterChapterId: number,
  { userId = OWNER, isModerator = false } = {}
) => moveStorylineChapter({ storylineId: 1, chapterId, afterChapterId, userId, isModerator });

const edges = () =>
  rows<{ chapterId: number; parentChapterId: number; canon: boolean }>(
    `SELECT "chapterId", "parentChapterId", canon FROM "StorylineChapterEdge"
     ORDER BY "chapterId", "parentChapterId"`
  );
const depths = async () =>
  Object.fromEntries(
    (await rows<{ id: number; depth: number }>(`SELECT id, depth FROM "StorylineChapter"`)).map(
      (r) => [r.id, r.depth]
    )
  );

/** Every chapter whose depth is not its first parent's + 1 (or, for the root, not 0). */
const depthDrift = () =>
  rows<{ id: number; depth: number; firstParentDepth: number | null }>(`
    SELECT c.id, c.depth, fp.depth AS "firstParentDepth"
    FROM "StorylineChapter" c
    LEFT JOIN LATERAL (
      SELECT p.depth FROM "StorylineChapterEdge" e
      JOIN "StorylineChapter" p ON p.id = e."parentChapterId"
      WHERE e."chapterId" = c.id
      ORDER BY e."createdAt", e."parentChapterId"
      LIMIT 1
    ) fp ON true
    WHERE c.depth IS DISTINCT FROM COALESCE(fp.depth + 1, 0)
    ORDER BY c.id
  `);

/** Parents with children whose canon count is not exactly one. */
const canonMiscount = () =>
  rows(`
    SELECT "parentChapterId", count(*) FILTER (WHERE canon)::int AS canon
    FROM "StorylineChapterEdge" GROUP BY 1
    HAVING count(*) FILTER (WHERE canon) <> 1
  `);

const mainRoute = async () => {
  const raw = pgliteRaw(db.pg);
  return (
    (await raw.queryRaw`${canonRouteWalk(1)} SELECT main.id FROM main ORDER BY hops`) as {
      id: number;
    }[]
  ).map((row) => row.id);
};

let txQueue: Promise<unknown> = Promise.resolve();
const runTransaction = (fn: (tx: unknown) => Promise<unknown>) => {
  const run = txQueue.then(async () => {
    await db.pg.exec('BEGIN');
    try {
      const result = await fn(w);
      await db.pg.exec('COMMIT');
      return result;
    } catch (error) {
      await db.pg.exec('ROLLBACK');
      throw error;
    }
  });
  txQueue = run.catch(() => undefined);
  return run;
};

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" ("id" integer PRIMARY KEY);
    CREATE TABLE "Placement" ("id" serial PRIMARY KEY, "surface" text NOT NULL,
      "targetType" text NOT NULL, "targetId" integer NOT NULL, "status" text NOT NULL);
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
    '20261122120000_storyline_pending_chapter',
  ])
    await db.pg.exec(migration(name));
  await db.pg.exec(`INSERT INTO "User" (id) VALUES (1), (2), (3), (4);`);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  edgeSecond = 10;
  await db.pg.exec(`
    DELETE FROM "Placement";
    DELETE FROM "StorylinePendingChapter";
    DELETE FROM "Post";
    DELETE FROM "StorylineBranchChoice";
    DELETE FROM "StorylineChapterEdge";
    DELETE FROM "StorylineChapter";
    DELETE FROM "Storyline";
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt")
      VALUES (1, 1, 'The Long Road', 1, now());
    INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth) VALUES (1, 1, 1, 0);
  `);
  for (const [i, id] of RUN.entries()) if (i) await addChapter(id, RUN[i - 1], i);

  const raw = pgliteRaw(db.pg);
  vi.mocked(bustFetchThroughCache).mockClear();
  w.$transaction.mockImplementation(runTransaction as never);
  w.$queryRaw.mockImplementation(raw.queryRaw as never);
  w.$executeRaw.mockImplementation(raw.executeRaw as never);
  w.storyline.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (
        await rows(
          `SELECT id, "userId", "maxNsfwLevel", "minorByScan", "tosViolation" FROM "Storyline" WHERE id = $1`,
          [where.id]
        )
      )[0] ?? null) as never
  );
});

const expectWellFormed = async (route: number[]) => {
  expect(await mainRoute()).toEqual(route);
  expect(await depthDrift()).toEqual([]);
  expect(await canonMiscount()).toEqual([]);
};

describe('moveStorylineChapter within the run', () => {
  it('moves a chapter earlier: 5 after 2', async () => {
    expect(await move(5, 2)).toEqual({ chapterIds: [1, 2, 5, 3, 4, 6] });
    await expectWellFormed([1, 2, 5, 3, 4, 6]);
    expect(await depths()).toMatchObject({ 5: 2, 3: 3, 4: 4, 6: 5 });
  });

  it('moves a chapter later: 3 after 5', async () => {
    expect(await move(3, 5)).toEqual({ chapterIds: [1, 2, 4, 5, 3, 6] });
    await expectWellFormed([1, 2, 4, 5, 3, 6]);
    expect(await depths()).toMatchObject({ 4: 2, 5: 3, 3: 4, 6: 5 });
  });

  it('moves a chapter to the end: 3 after 6', async () => {
    expect(await move(3, 6)).toEqual({ chapterIds: [1, 2, 4, 5, 6, 3] });
    await expectWellFormed([1, 2, 4, 5, 6, 3]);
  });

  it('moves the last chapter earlier: 6 after 1', async () => {
    expect(await move(6, 1)).toEqual({ chapterIds: [1, 6, 2, 3, 4, 5] });
    await expectWellFormed([1, 6, 2, 3, 4, 5]);
  });

  it('moves a chapter one place on: 3 after 4', async () => {
    expect(await move(3, 4)).toEqual({ chapterIds: [1, 2, 4, 3, 5, 6] });
    await expectWellFormed([1, 2, 4, 3, 5, 6]);
  });

  it('leaves the fork after the run, and what hangs off it, where they were', async () => {
    await forkAfterRun();
    expect(await move(2, 5)).toEqual({ chapterIds: [1, 3, 4, 5, 2, 6] });
    await expectWellFormed([1, 3, 4, 5, 2, 6, 7, 9]);
    expect(await depths()).toMatchObject({ 6: 5, 7: 6, 8: 6, 9: 7 });
    expect((await edges()).filter((e) => e.chapterId >= 7)).toEqual([
      { chapterId: 7, parentChapterId: 6, canon: true },
      { chapterId: 8, parentChapterId: 6, canon: false },
      { chapterId: 9, parentChapterId: 7, canon: true },
    ]);
  });

  it('moves a run that starts after a fork, keeping the fork and its other way on', async () => {
    // 2 forks: 10 -> 11 -> 12 is a second run whose head is 10.
    await addChapter(10, 2, 2, { canon: false });
    await addChapter(11, 10, 3);
    await addChapter(12, 11, 4);
    expect(await move(12, 10)).toEqual({ chapterIds: [10, 12, 11] });
    expect(await depthDrift()).toEqual([]);
    expect(await canonMiscount()).toEqual([]);
    expect(await mainRoute()).toEqual(RUN);
  });

  it('changes nothing when the chapter already follows that one', async () => {
    const before = await edges();
    expect(await move(4, 3)).toEqual({ chapterIds: RUN });
    expect(await edges()).toEqual(before);
  });

  it("points readers' choices at each rewired chapter's new way on, and busts their counts", async () => {
    // Recorded wherever a reader chose, not only at forks.
    await db.pg.exec(`
      INSERT INTO "StorylineBranchChoice" ("userId", "parentChapterId", "chapterId")
        VALUES (1, 2, 3), (2, 4, 5), (3, 5, 6), (4, 3, 4);
    `);
    await move(5, 2);

    expect(
      await rows(
        `SELECT "userId", "parentChapterId", "chapterId" FROM "StorylineBranchChoice" ORDER BY 1`
      )
    ).toEqual([
      { userId: 1, parentChapterId: 2, chapterId: 5 },
      { userId: 2, parentChapterId: 4, chapterId: 6 },
      { userId: 3, parentChapterId: 5, chapterId: 3 },
      { userId: 4, parentChapterId: 3, chapterId: 4 },
    ]);
    for (const id of [2, 4, 5])
      expect(bustFetchThroughCache).toHaveBeenCalledWith(
        `${REDIS_KEYS.CACHES.STORYLINE_FORK_COUNTS}:${id}`
      );
  });

  it('drops the choice at a chapter left with no way on', async () => {
    await db.pg.exec(`
      INSERT INTO "StorylineBranchChoice" ("userId", "parentChapterId", "chapterId") VALUES (1, 5, 6);
    `);
    await move(6, 2);
    expect(await rows(`SELECT * FROM "StorylineBranchChoice"`)).toEqual([]);
  });

  it('moves no money: no placement is written and nothing calls out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await move(5, 2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(w.placement.create).not.toHaveBeenCalled();
    expect(w.placement.createMany).not.toHaveBeenCalled();
    expect(w.placementTransaction.createMany).not.toHaveBeenCalled();
    expect(await rows(`SELECT id FROM "StorylineChapter" WHERE "placementId" IS NOT NULL`)).toEqual(
      []
    );
  });

  it("lets a moderator move the owner's chapters", async () => {
    trackModActivity.mockClear();
    expect(await move(5, 2, { userId: 4, isModerator: true })).toEqual({
      chapterIds: [1, 2, 5, 3, 4, 6],
    });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(4, {
      entityType: 'storyline',
      entityId: 1,
      activity: 'moveChapter',
    });
    await expectWellFormed([1, 2, 5, 3, 4, 6]);
  });
});

const refuses = async (attempt: () => Promise<unknown>, expected: Record<string, unknown>) => {
  const before = [await edges(), await depths()];
  await expect(attempt()).rejects.toMatchObject(expected);
  expect([await edges(), await depths()]).toEqual(before);
};
const badRequest = (message: string) => ({ code: 'BAD_REQUEST', message });

describe('moveStorylineChapter refusals', () => {
  const notInOneLine = badRequest('Only your own chapters in a single line can be moved');

  it("refuses a contributor's chapter in the span", async () => {
    await db.pg.exec(
      `UPDATE "StorylineChapter" SET "userId" = 2, "placementId" = 901 WHERE id = 4`
    );
    await refuses(() => move(5, 2), notInOneLine);
    await refuses(() => move(3, 5), notInOneLine);
  });

  it('refuses moving a removed chapter, or moving past one', async () => {
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 4`);
    await refuses(() => move(4, 2), notInOneLine);
    await refuses(() => move(5, 2), notInOneLine);
  });

  it("refuses moving a contributor's chapter", async () => {
    await forkAfterRun();
    await refuses(() => move(9, 3), notInOneLine);
  });

  it('refuses moving after a fork, or moving a fork', async () => {
    await forkAfterRun();
    await refuses(() => move(3, 6), notInOneLine);
    await refuses(() => move(6, 2), notInOneLine);
  });

  it('refuses moving past a fork into another run', async () => {
    await addChapter(10, 3, 3, { canon: false });
    await refuses(() => move(5, 2), notInOneLine);
    await refuses(() => move(2, 10), notInOneLine);
  });

  it('refuses a span a rejoin edge touches', async () => {
    // 1 -> 20 is a side branch that rejoins at 4; 4's first parent stays 3.
    await addChapter(20, 1, 1, { canon: false });
    await addEdge(4, 20, true);
    await refuses(() => move(3, 5), notInOneLine);
    await refuses(() => move(5, 3), notInOneLine);
    await refuses(() => move(4, 5), notInOneLine);
    // Each chapter it touches has one way in, so nothing goes straight after the rejoined 4.
    await refuses(() => move(6, 4), notInOneLine);
  });

  it('refuses chapter 1', async () => {
    await refuses(() => move(1, 3), badRequest('The first chapter cannot be moved'));
  });

  it('refuses anyone but the owner or a moderator', async () => {
    await refuses(() => move(5, 2, { userId: READER }), { code: 'UNAUTHORIZED' });
  });

  it('refuses a taken-down storyline', async () => {
    await db.pg.exec(`UPDATE "Storyline" SET "tosViolation" = true`);
    await refuses(() => move(5, 2), badRequest('This storyline was taken down'));
  });

  it('refuses a chapter of another storyline', async () => {
    await refuses(() => move(5, 999), { code: 'NOT_FOUND' });
  });
});

describe('moveStorylineChapter with a continuation waiting', () => {
  // Moving 5 after 2 changes what follows 4 (its old parent), 5 and 2.
  const waiting = badRequest('This chapter has a continuation waiting for review; answer it first');
  const postOf = async (chapterId: number) => {
    const postId = 500 + chapterId;
    await db.pg.query(`INSERT INTO "Post" (id, "userId") VALUES ($1, $2)`, [postId, OWNER]);
    await db.pg.query(`UPDATE "StorylineChapter" SET "postId" = $1 WHERE id = $2`, [
      postId,
      chapterId,
    ]);
    return postId;
  };
  const placementOn = async (chapterId: number, status = 'pending') =>
    db.pg.query(
      `INSERT INTO "Placement" (surface, "targetType", "targetId", status)
       VALUES ('storyline', 'post', $1, $2)`,
      [await postOf(chapterId), status]
    );
  const draftAfter = async (chapterId: number) => {
    const draftPostId = 900 + chapterId;
    await db.pg.query(`INSERT INTO "Post" (id, "userId") VALUES ($1, $2)`, [draftPostId, OWNER]);
    await db.pg.query(
      `INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "parentChapterId", "userId")
       VALUES ($1, 1, $2, $3)`,
      [draftPostId, chapterId, OWNER]
    );
  };

  for (const [role, chapterId] of [
    ['the moved chapter', 5],
    ['its old parent', 4],
    ['the chapter it moves after', 2],
  ] as const) {
    it(`refuses while a paid continuation of ${role} is pending`, async () => {
      await placementOn(chapterId);
      await refuses(() => move(5, 2), waiting);
    });

    it(`refuses while a draft continuing ${role} is pending`, async () => {
      await draftAfter(chapterId);
      await refuses(() => move(5, 2), waiting);
    });
  }

  it('moves when the waiting continuation is of a chapter whose next one stays', async () => {
    await placementOn(3);
    await draftAfter(6);
    expect(await move(5, 2)).toEqual({ chapterIds: [1, 2, 5, 3, 4, 6] });
  });

  it('moves when the continuation was already answered', async () => {
    await placementOn(5, 'declined');
    expect(await move(5, 2)).toEqual({ chapterIds: [1, 2, 5, 3, 4, 6] });
  });
});
