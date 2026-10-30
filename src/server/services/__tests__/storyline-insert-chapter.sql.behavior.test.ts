import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { REDIS_KEYS } from '~/server/redis/client';
import { createStorylineLinkJudge } from '~/shared/utils/storyline-graph';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

const { trackModActivity } = vi.hoisted(() => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
  HiddenUsers: { getCached: vi.fn().mockResolvedValue([]) },
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustFetchThroughCache: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Inserting a chapter on an edge, run as written against an in-process Postgres built from the
 * shipped storyline migrations. The rewire, the depth shift over first-parent descendants and the
 * moved branch choices all live in SQL, which a mocked client cannot see.
 */

const {
  addOwnerChapter,
  addOwnerChapterAtEnd,
  canonRouteWalk,
  getStorylinePath,
  insertStorylineChapter,
  setCanonChapter,
} = await import('~/server/services/storyline.service');
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
const r = dbMock.dbRead;

const OWNER = 1;
const CONTRIBUTOR = 2;
const READER = 3;
const STORY = 1;

// Trunk 1 -> 2 -> P -> C -> 5 -> 6, all canon. Off 2, branch M joins C later, so P is C's first
// parent. Off P, branch 30; off C, branch 40 -> 41. 50 continues 30 and is joined from 5 later, so
// its first parent is outside C's subtree. 60 is a contributor's chapter continuing 6.
const P = 3;
const C = 4;
const M = 20;
const NODES: [id: number, depth: number, placementId?: number][] = [
  [1, 0],
  [2, 1],
  [P, 2],
  [C, 3],
  [5, 4],
  [6, 5],
  [M, 2],
  [30, 3],
  [40, 4],
  [41, 5],
  [50, 4],
  [51, 5],
  [60, 6, 900],
];
const EDGES: [chapterId: number, parentChapterId: number, canon: boolean][] = [
  [2, 1, true],
  [P, 2, true],
  [C, P, true],
  [5, C, true],
  [6, 5, true],
  [M, 2, false],
  [30, P, false],
  [40, C, false],
  [41, 40, true],
  [50, 30, true],
  [51, 50, true],
  [60, 6, true],
  // Later links: rejoins.
  [C, M, true],
  [50, 5, false],
];

let nextPostId = 100;
const post = async ({
  userId = OWNER,
  nsfwLevel = NsfwLevel.PG as number,
  publishedAt = "now() - interval '1 minute'",
  tosViolation = false,
} = {}) => {
  const id = nextPostId++;
  await db.pg.query(
    `INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt", "tosViolation")
     VALUES ($1, $2, $3, ${publishedAt}, $4)`,
    [id, userId, nsfwLevel, tosViolation]
  );
  return id;
};

const insert = (
  postId: number,
  { parentChapterId = P, childChapterId = C, userId = OWNER, isModerator = false } = {}
) =>
  insertStorylineChapter({
    storylineId: STORY,
    parentChapterId,
    childChapterId,
    postId,
    userId,
    isModerator,
  });

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;
const edges = () =>
  rows<{ chapterId: number; parentChapterId: number; canon: boolean }>(
    `SELECT "chapterId", "parentChapterId", canon FROM "StorylineChapterEdge"
     ORDER BY "chapterId", "parentChapterId"`
  );
const depthOf = async (id: number) =>
  (await rows<{ depth: number }>(`SELECT depth FROM "StorylineChapter" WHERE id = $1`, [id]))[0]
    ?.depth;

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

const mainRoute = async () => {
  const raw = pgliteRaw(db.pg);
  return (
    (await raw.queryRaw`${canonRouteWalk(1)} SELECT main.id FROM main ORDER BY hops`) as {
      id: number;
    }[]
  ).map((row) => row.id);
};

// One transaction at a time, as the storyline row lock makes them: PGlite has one session, so two
// interleaved here would share it rather than wait.
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
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
  ])
    await db.pg.exec(migration(name));
  await db.pg.exec(`INSERT INTO "User" (id) VALUES (1), (2), (3), (4);`);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    DELETE FROM "StorylineBranchChoice";
    DELETE FROM "StorylineChapterEdge";
    DELETE FROM "StorylineChapter";
    DELETE FROM "Storyline";
    DELETE FROM "Post";
    SELECT setval(pg_get_serial_sequence('"StorylineChapter"', 'id'), 1000);
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt")
      VALUES (1, 1, 'The Long Road', 1, now());
  `);
  for (const [id, depth, placementId] of NODES)
    await db.pg.query(
      `INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "placementId")
       VALUES ($1, 1, $2, $3, $4)`,
      [id, placementId ? CONTRIBUTOR : OWNER, depth, placementId ?? null]
    );
  for (const [i, [chapterId, parentChapterId, canon]] of EDGES.entries())
    await db.pg.query(
      `INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
       VALUES (1, $1, $2, $3, $4)`,
      [chapterId, parentChapterId, canon, `2026-10-01T00:00:${10 + i}Z`]
    );

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
  w.post.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) => {
    const [row] = await rows<Record<string, unknown> & { chapterId: number | null }>(
      `SELECT p."userId", p."nsfwLevel", p."publishedAt", p."tosViolation", c.id AS "chapterId"
       FROM "Post" p LEFT JOIN "StorylineChapter" c ON c."postId" = p.id WHERE p.id = $1`,
      [where.id]
    );
    if (!row) return null;
    const { chapterId, ...rest } = row;
    return { ...rest, storylineChapter: chapterId ? { id: chapterId } : null };
  }) as never);
  w.storylineChapter.create.mockImplementation(
    (async ({
      data,
    }: {
      data: { storylineId: number; postId: number; userId: number; depth: number };
    }) =>
      (
        await rows(
          `INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
         VALUES ($1, $2, $3, $4) RETURNING id`,
          [data.storylineId, data.postId, data.userId, data.depth]
        )
      )[0]) as never
  );
  w.storylineChapterEdge.create.mockImplementation(
    (async ({
      data,
    }: {
      data: { storylineId: number; chapterId: number; parentChapterId: number; canon: boolean };
    }) =>
      (
        await rows(
          `INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
         VALUES ($1, $2, $3, $4) RETURNING *`,
          [data.storylineId, data.chapterId, data.parentChapterId, data.canon]
        )
      )[0]) as never
  );
  // A chapter add's reads of its parent and of the parent's canon child.
  w.storylineChapter.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const [row] = await rows<Record<string, unknown>>(
      `SELECT c.id, c."storylineId", c.depth, c."removedAt", st."userId", st."maxNsfwLevel",
         st."minorByScan", st."tosViolation"
       FROM "StorylineChapter" c JOIN "Storyline" st ON st.id = c."storylineId" WHERE c.id = $1`,
      [where.id]
    );
    if (!row) return null;
    const { userId, maxNsfwLevel, minorByScan, tosViolation, ...chapter } = row;
    return { ...chapter, storyline: { userId, maxNsfwLevel, minorByScan, tosViolation } };
  }) as never);
  w.storylineChapterEdge.findFirst.mockImplementation(
    (async ({ where }: { where: { parentChapterId: number; canon: true } }) =>
      (
        await rows(
          `SELECT "chapterId" FROM "StorylineChapterEdge" WHERE "parentChapterId" = $1 AND canon`,
          [where.parentChapterId]
        )
      )[0] ?? null) as never
  );

  // The reading path's own reads, as in storyline-rejoin.sql.behavior.test.ts.
  r.$queryRaw.mockImplementation(raw.queryRaw as never);
  r.storylineChapter.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await rows(`SELECT "storylineId" FROM "StorylineChapter" WHERE id = $1`, [where.id]))[0] ??
      null) as never
  );
  r.storylineChapter.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) =>
    (
      await rows<{ id: number }>(
        `SELECT id, depth, "removedAt" FROM "StorylineChapter" WHERE id = ANY($1::int[]) ORDER BY id`,
        [where.id.in]
      )
    ).map((row) => ({ ...row, post: null }))) as never);
  r.post.findMany.mockResolvedValue([] as never);
  r.storylineChapterEdge.groupBy.mockImplementation((async ({
    where,
  }: {
    where: { parentChapterId: { in: number[] } };
  }) =>
    (
      await rows<{ parentChapterId: number; n: number }>(
        `SELECT "parentChapterId", count(*)::int AS n FROM "StorylineChapterEdge"
         WHERE "parentChapterId" = ANY($1::int[]) GROUP BY 1`,
        [where.parentChapterId.in]
      )
    ).map(({ parentChapterId, n }) => ({ parentChapterId, _count: { _all: n } }))) as never);
  r.storyline.findUnique.mockResolvedValue({
    id: 1,
    userId: OWNER,
    title: 'The Long Road',
    status: 'Ongoing',
    whoCanContinue: 'Anyone',
    maxNsfwLevel: NsfwLevel.PG,
    minorByScan: false,
    tosViolation: false,
    nsfwLevel: 0,
    moderatorNsfwLevel: null,
    createdAt: new Date('2026-10-01'),
    user: { id: OWNER, username: 'owner', bannedAt: null, deletedAt: null },
    chapters: [{ id: 1, postId: null, post: null }],
  } as never);
});

describe('insertStorylineChapter on a first-parent edge', () => {
  it("keeps every chapter one deeper than its first parent, and a rejoin's own depth", async () => {
    const { chapterId: X } = await insert(await post());

    expect(await depthDrift()).toEqual([]);
    expect(await depthOf(X)).toBe(3);
    // C and its first-parent line move down one; 50, whose first parent is 30, does not.
    expect([await depthOf(C), await depthOf(5), await depthOf(6), await depthOf(60)]).toEqual([
      4, 5, 6, 7,
    ]);
    expect([await depthOf(40), await depthOf(41)]).toEqual([5, 6]);
    expect([await depthOf(30), await depthOf(50), await depthOf(51), await depthOf(M)]).toEqual([
      3, 4, 5, 2,
    ]);
  });

  it('rewires only the one edge: P -> X -> C, every other edge as it was', async () => {
    const before = await edges();
    const { chapterId: X } = await insert(await post());

    const expected = [
      ...before.filter((e) => !(e.chapterId === C && e.parentChapterId === P)),
      { chapterId: C, parentChapterId: X, canon: true },
      { chapterId: X, parentChapterId: P, canon: true },
    ].sort((a, b) => a.chapterId - b.chapterId || a.parentChapterId - b.parentChapterId);
    expect(await edges()).toEqual(expected);
  });

  it('keeps C reached through P when no way in is given, though C was joined from M too', async () => {
    const { chapterId: X } = await insert(await post());

    const { chapters } = await getStorylinePath({
      chapterId: C,
      viewer: undefined,
      browsingLevel: NsfwLevel.PG,
    });
    expect(chapters.map((c) => [c.chapterId, c.depth])).toEqual([
      [1, 0],
      [2, 1],
      [P, 2],
      [X, 3],
      [C, 4],
    ]);
  });

  it('adds no skip or loop: the link judge accepts every edge again', async () => {
    await insert(await post());

    const all = await edges();
    const refusals = all.flatMap((edge) => {
      const others = all.filter((e) => e !== edge);
      const refusal = createStorylineLinkJudge(others, edge.parentChapterId)(edge.chapterId);
      return refusal ? [[edge.parentChapterId, edge.chapterId, refusal]] : [];
    });
    expect(refusals).toEqual([]);
  });

  it('puts X on the main route when the edge was canon, with one canon edge per parent', async () => {
    const { chapterId: X } = await insert(await post());

    expect(await mainRoute()).toEqual([1, 2, P, X, C, 5, 6, 60]);
    expect(
      await rows(
        `SELECT "parentChapterId" FROM "StorylineChapterEdge" WHERE canon
         GROUP BY 1 HAVING count(*) > 1`
      )
    ).toEqual([]);
  });

  it("moves readers' choice of C at P to X, keeping P's counts, and busts P's cached counts", async () => {
    await db.pg.exec(`
      INSERT INTO "StorylineBranchChoice" ("userId", "parentChapterId", "chapterId")
        VALUES (1, ${P}, ${C}), (2, ${P}, ${C}), (3, ${P}, 30), (4, ${C}, 5);
    `);
    const { chapterId: X } = await insert(await post());

    expect(
      await rows(
        `SELECT "userId", "parentChapterId", "chapterId" FROM "StorylineBranchChoice" ORDER BY 1`
      )
    ).toEqual([
      { userId: 1, parentChapterId: P, chapterId: X },
      { userId: 2, parentChapterId: P, chapterId: X },
      { userId: 3, parentChapterId: P, chapterId: 30 },
      { userId: 4, parentChapterId: C, chapterId: 5 },
    ]);
    expect(bustFetchThroughCache).toHaveBeenCalledWith(
      `${REDIS_KEYS.CACHES.STORYLINE_FORK_COUNTS}:${P}`
    );
  });

  it('moves no money: no placement is written and nothing calls out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await insert(await post());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(w.placement.create).not.toHaveBeenCalled();
    expect(w.placement.createMany).not.toHaveBeenCalled();
    expect(w.placementTransaction.createMany).not.toHaveBeenCalled();
    const [x] = await rows<{ userId: number; placementId: number | null }>(
      `SELECT "userId", "placementId" FROM "StorylineChapter" WHERE id > 1000`
    );
    expect(x).toEqual({ userId: OWNER, placementId: null });
  });

  it("writes the owner's chapter when a moderator inserts the owner's post", async () => {
    trackModActivity.mockClear();
    const { chapterId: X } = await insert(await post(), { userId: 4, isModerator: true });
    expect(await rows(`SELECT "userId" FROM "StorylineChapter" WHERE id = $1`, [X])).toEqual([
      { userId: OWNER },
    ]);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(4, {
      entityType: 'storyline',
      entityId: STORY,
      activity: 'insertChapter',
    });
  });
});

describe('insertStorylineChapter on an edge that is not its child’s first', () => {
  it('leaves the main route and the child’s depth alone on a non-canon branch edge', async () => {
    const before = await mainRoute();
    const { chapterId: X } = await insert(await post(), { parentChapterId: C, childChapterId: 40 });

    expect(await mainRoute()).toEqual(before);
    expect(await depthOf(X)).toBe(4);
    expect([await depthOf(40), await depthOf(41)]).toEqual([5, 6]);
    expect(await depthDrift()).toEqual([]);
  });

  it('shifts nothing on a rejoin edge: X joins, the child keeps its first parent', async () => {
    const { chapterId: X } = await insert(await post(), { parentChapterId: 5, childChapterId: 50 });

    expect(await depthOf(X)).toBe(5);
    expect(await depthOf(50)).toBe(4);
    expect(await depthDrift()).toEqual([]);
  });
});

describe("insertStorylineChapter before a contributor's chapter", () => {
  it('refuses on its first-parent edge', async () => {
    const before = await edges();
    await expect(
      insert(await post(), { parentChapterId: 6, childChapterId: 60 })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: "A chapter cannot be inserted before a contributor's chapter",
    });
    expect(await edges()).toEqual(before);
  });

  it('allows it on a rejoin edge, which its placement never named', async () => {
    await db.pg.exec(`
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon, "createdAt")
        VALUES (1, 60, 51, true, '2026-10-02T00:00:00Z');
    `);
    const { chapterId: X } = await insert(await post(), {
      parentChapterId: 51,
      childChapterId: 60,
    });

    expect(await depthOf(X)).toBe(6);
    expect(await depthOf(60)).toBe(6);
    expect(await depthDrift()).toEqual([]);
  });
});

// Serialised by `runTransaction`, standing in for the storyline row lock, which PGlite's one session
// cannot make anything wait on. What this pins is the loser's answer once it gets the lock.
describe('two inserts on one edge', () => {
  it('lets one through and refuses the other with a 400, never both', async () => {
    const [first, second] = [await post(), await post()];
    const results = await Promise.allSettled([insert(first), insert(second)]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((result) => result.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That chapter no longer follows this one',
    });
    expect(await rows(`SELECT id FROM "StorylineChapter" WHERE id > 1000`)).toHaveLength(1);
    expect(await depthDrift()).toEqual([]);
  });
});

/**
 * PGlite has one session, so the shared lock cannot make the add wait here. These play another
 * writer's statements between the add's first read of its parent and its locks, the order a stale
 * read needs, and pin that the add goes by what it reads under its locks.
 */
describe('a chapter add whose parent changes after its first read', () => {
  /** Holds `addOwnerChapter` after it has read its parent, while it checks its post. */
  const holdAddAtItsPost = (addedPost: number) => {
    w.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(w)) as never);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let paused!: () => void;
    const pausedAt = new Promise<void>((resolve) => (paused = resolve));
    const findPost = w.post.findUnique.getMockImplementation()!;
    w.post.findUnique.mockImplementation((async (args: { where: { id: number } }) => {
      if (args.where.id === addedPost) {
        paused();
        await released;
      }
      return findPost(args as never);
    }) as never);
    return { pausedAt, release };
  };

  it('takes the depth its parent has after an insert moved it down', async () => {
    const [addedPost, insertedPost] = [await post(), await post()];
    const { pausedAt, release } = holdAddAtItsPost(addedPost);

    const adding = addOwnerChapter({ parentChapterId: 5, postId: addedPost, userId: OWNER });
    await pausedAt;
    await insert(insertedPost);
    release();
    const { chapterId } = await adding;

    expect(await depthOf(5)).toBe(5);
    expect(await depthOf(chapterId)).toBe(6);
    expect(await depthDrift()).toEqual([]);
  });

  it('refuses a parent removed since it was first read', async () => {
    const addedPost = await post();
    const { pausedAt, release } = holdAddAtItsPost(addedPost);

    const adding = addOwnerChapter({ parentChapterId: 5, postId: addedPost, userId: OWNER });
    await pausedAt;
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 5`);
    release();

    await expect(adding).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A removed chapter cannot be continued',
    });
  });

  // "Add to a storyline" from a post's menu. The client once picked the end from its own read,
  // capped and possibly stale, and a wrong guess quietly made a side branch.
  describe('at the end of the main path', () => {
    const edgeOf = async (chapterId: number) =>
      (
        await rows<{ parentChapterId: number; canon: boolean }>(
          `SELECT "parentChapterId", canon FROM "StorylineChapterEdge" WHERE "chapterId" = $1`,
          [chapterId]
        )
      )[0];

    it("adds the post as the canon child of the main path's last chapter", async () => {
      const { chapterId } = await addOwnerChapterAtEnd({
        storylineId: STORY,
        postId: await post(),
        userId: OWNER,
      });

      // The trunk ends at 60, a contributor's canon chapter after 6.
      expect(await edgeOf(chapterId)).toEqual({ parentChapterId: 60, canon: true });
      expect(await depthOf(chapterId)).toBe(7);
    });

    // The reading path stops at STORYLINE_PATH_LIMIT (200) chapters; the end is past that.
    it('finds the end of a main path longer than the reading cap', async () => {
      await db.pg.exec(`
        INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt")
          VALUES (2, 1, 'Very Long', 1, now());
        INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth)
          SELECT 5000 + n, 2, 1, n FROM generate_series(0, 204) n;
        INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
          SELECT 2, 5000 + n, 4999 + n, true FROM generate_series(1, 204) n;
      `);

      const { chapterId } = await addOwnerChapterAtEnd({
        storylineId: 2,
        postId: await post(),
        userId: OWNER,
      });

      expect(await edgeOf(chapterId)).toEqual({ parentChapterId: 5204, canon: true });
    });

    it('refuses rather than branch when the end moves while it adds', async () => {
      const [addedPost, otherPost] = [await post(), await post()];
      const { pausedAt, release } = holdAddAtItsPost(addedPost);

      const adding = addOwnerChapterAtEnd({ storylineId: STORY, postId: addedPost, userId: OWNER });
      await pausedAt;
      await addOwnerChapter({ parentChapterId: 60, postId: otherPost, userId: OWNER });
      release();

      await expect(adding).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'The storyline changed while adding. Try again',
      });
    });
  });
});

describe('around the insert', () => {
  it("gives the new chapter the child's place among the parent's ways on", async () => {
    const { chapterId: X } = await insert(await post());
    expect(
      await rows(
        `SELECT "chapterId" FROM "StorylineChapterEdge" WHERE "parentChapterId" = $1
         ORDER BY "createdAt", "chapterId"`,
        [P]
      )
    ).toEqual([{ chapterId: X }, { chapterId: 30 }]);
  });

  it('reports a committed insert as done when the cached counts cannot be busted', async () => {
    vi.mocked(bustFetchThroughCache).mockRejectedValueOnce(new Error('redis down'));
    const { chapterId: X } = await insert(await post());
    expect(await rows(`SELECT id FROM "StorylineChapter" WHERE id = $1`, [X])).toEqual([{ id: X }]);
  });

  it('turns losing the post to another chapter since the check into a 400', async () => {
    w.storylineChapter.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) as never
    );
    await expect(insert(await post())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This post is already in a storyline',
    });
  });

  // setCanonChapter reads the edge before its transaction; an insert can move it in between.
  it('refuses to make the moved edge canon rather than leave the parent with no canon child', async () => {
    w.storylineChapterEdge.findMany.mockImplementation((async ({
      where,
    }: {
      where: { chapterId: number; parentChapterId: number };
    }) =>
      (
        await rows<{ parentChapterId: number; storylineId: number; removedAt: Date | null }>(
          `SELECT e."parentChapterId", e."storylineId", c."removedAt" FROM "StorylineChapterEdge" e
           JOIN "StorylineChapter" c ON c.id = e."chapterId"
           WHERE e."chapterId" = $1 AND e."parentChapterId" = $2`,
          [where.chapterId, where.parentChapterId]
        )
      ).map(({ removedAt, ...edge }) => ({ ...edge, chapter: { removedAt } }))) as never);
    w.storylineChapterEdge.updateMany.mockImplementation((async ({
      where,
      data,
    }: {
      where: { parentChapterId: number; chapterId?: number; canon?: boolean };
      data: { canon: boolean };
    }) => ({
      count:
        (
          await db.pg.query(
            `UPDATE "StorylineChapterEdge" SET canon = $1 WHERE "parentChapterId" = $2
             AND ($3::int IS NULL OR "chapterId" = $3) AND ($4::boolean IS NULL OR canon = $4)`,
            [data.canon, where.parentChapterId, where.chapterId ?? null, where.canon ?? null]
          )
        ).affectedRows ?? 0,
    })) as never);
    w.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
      await db.pg.exec('BEGIN');
      try {
        const result = await fn(w);
        await db.pg.exec('COMMIT');
        return result;
      } catch (error) {
        await db.pg.exec('ROLLBACK');
        throw error;
      }
    }) as never);
    const insertedPost = await post();
    // Held at its owner check, after it has read the edge and before its transaction.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let paused!: () => void;
    const pausedAt = new Promise<void>((resolve) => (paused = resolve));
    const findStoryline = w.storyline.findUnique.getMockImplementation()!;
    w.storyline.findUnique.mockImplementationOnce((async (args: never) => {
      paused();
      await released;
      return findStoryline(args);
    }) as never);

    const setting = setCanonChapter({ chapterId: C, parentChapterId: P, userId: OWNER });
    await pausedAt;
    const { chapterId: X } = await insert(insertedPost);
    release();

    await expect(setting).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That chapter no longer follows this one',
    });
    expect(await mainRoute()).toEqual([1, 2, P, X, C, 5, 6, 60]);
  });
});

describe('insertStorylineChapter refusals', () => {
  const refuses = async (attempt: () => Promise<unknown>, expected: Record<string, unknown>) => {
    const before = await edges();
    await expect(attempt()).rejects.toMatchObject(expected);
    expect(await edges()).toEqual(before);
    expect(await rows(`SELECT id FROM "StorylineChapter" WHERE id > 1000`)).toEqual([]);
  };
  const badRequest = (message: string) => ({ code: 'BAD_REQUEST', message });

  it('refuses before chapter 1, which nothing leads into', async () => {
    await refuses(
      async () => insert(await post(), { parentChapterId: 2, childChapterId: 1 }),
      badRequest('That chapter no longer follows this one')
    );
  });

  it('refuses two chapters that are not parent and child', async () => {
    await refuses(
      async () => insert(await post(), { parentChapterId: P, childChapterId: 5 }),
      badRequest('That chapter no longer follows this one')
    );
  });

  it('refuses anyone but the owner or a moderator', async () => {
    await refuses(async () => insert(await post({ userId: READER }), { userId: READER }), {
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a taken-down storyline', async () => {
    await db.pg.exec(`UPDATE "Storyline" SET "tosViolation" = true`);
    await refuses(async () => insert(await post()), badRequest('This storyline was taken down'));
  });

  it('refuses after a removed chapter', async () => {
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = ${P}`);
    await refuses(
      async () => insert(await post()),
      badRequest('A removed chapter cannot be continued')
    );
  });

  describe('the rules for a post to be a chapter', () => {
    it('refuses a post that does not exist', async () => {
      await refuses(() => insert(99_999), { code: 'NOT_FOUND', message: 'Post not found' });
    });

    it("refuses someone else's post", async () => {
      await refuses(async () => insert(await post({ userId: CONTRIBUTOR })), {
        code: 'UNAUTHORIZED',
        message: 'You can only add your own posts',
      });
    });

    it('refuses a post taken down for a violation', async () => {
      await refuses(
        async () => insert(await post({ tosViolation: true })),
        badRequest("This post or one of its images can't be used in a storyline")
      );
    });

    it('refuses an unpublished post, and one scheduled for later', async () => {
      await refuses(
        async () => insert(await post({ publishedAt: 'NULL' })),
        badRequest('Publish the post before adding it to a storyline')
      );
      await refuses(
        async () => insert(await post({ publishedAt: "now() + interval '1 day'" })),
        badRequest('Publish the post before adding it to a storyline')
      );
    });

    it('refuses a post that is already a chapter', async () => {
      const postId = await post();
      await db.pg.exec(`UPDATE "StorylineChapter" SET "postId" = ${postId} WHERE id = 41`);
      await refuses(() => insert(postId), badRequest('This post is already in a storyline'));
    });

    it('refuses a post not yet rated', async () => {
      await refuses(
        async () => insert(await post({ nsfwLevel: 0 })),
        badRequest('This post has not been rated yet. Try again once it has been')
      );
    });

    it("refuses a post rated above the storyline's ceiling", async () => {
      await refuses(
        async () => insert(await post({ nsfwLevel: NsfwLevel.R })),
        badRequest(
          "This post is rated above this storyline's maximum. This storyline allows up to PG; this post is R"
        )
      );
    });
  });
});
