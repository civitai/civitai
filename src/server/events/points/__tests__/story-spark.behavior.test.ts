import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as Award from '~/server/events/points/award';
import type { EventPointAction, EventPointRemoval } from '~/server/events/points/types';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A story started from a hatted image scores as that image's remix. Which stories count is SQL (live
 * chapter 1, not taken down, not your own image, the day's limit), so it runs against Postgres. The
 * engine is a small fake of its contract (types.ts): one first per (type, entity, person), a ledger
 * keyed by sourceId, an earning counting while that id's latest row is an add. Redis sets are a Map.
 */

const engine = vi.hoisted(() => {
  const seen = new Set<string>();
  const ledger = new Map<string, 'add' | 'remove'>();
  const adds: string[] = [];
  const hatted = new Set<number>();
  const firstKey = (a: { type: string; entityId: number; actorId: number }) =>
    `${a.type}:${a.entityId}:${a.actorId}`;
  return {
    seen,
    ledger,
    adds,
    hatted,
    awardEventPoints: vi.fn(async (actions: EventPointAction[]) => {
      let firsts = 0;
      for (const a of actions) {
        if (seen.has(firstKey(a))) continue;
        seen.add(firstKey(a));
        ledger.set(a.sourceId ?? '', 'add');
        adds.push(a.sourceId ?? '');
        firsts++;
      }
      return firsts;
    }),
    removeEventPoints: vi.fn(async (removals: EventPointRemoval[]) => {
      for (const r of removals) {
        seen.delete(firstKey(r));
        ledger.set(r.sourceId, 'remove');
      }
    }),
    reset() {
      seen.clear();
      ledger.clear();
      adds.length = 0;
      hatted.clear();
    },
  };
});
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
  onEventPointsSwitchOn: () => () => undefined,
}));
vi.mock('~/server/events/points/self-heal', () => ({ healEventPoints: vi.fn() }));
vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints: engine.awardEventPoints,
  removeEventPoints: engine.removeEventPoints,
  isHattedEntity: (type: string, id: number) => type === 'Image' && engine.hatted.has(id),
  isHattedEntityOnceLoaded: async (type: string, id: number) =>
    type === 'Image' && engine.hatted.has(id),
  hasTurfMark: async () => false,
}));
const events = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => events.list }));

// unpublishPostAsModerator runs for real against Postgres; its index and cache steps are not points.
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  userPostCountCache: { refresh: vi.fn() },
  userImageVideoCountCaches: { refresh: vi.fn() },
}));

const {
  onPlacementsTakenDown,
  onStorySparked,
  onStorySparkLost,
  onStorySparkPostsHidden,
  onStorySparkPostsRestored,
  onStorySparkRemoved,
} = await import('~/server/events/points/hooks');
const { unpublishPostAsModerator } = await import('~/server/services/post.service');

const pg = new PGlite();
const OWNER = 1; // the image's creator
const WRITER = 2; // starts stories from it
const HOST = 100;
const remixSource = (imageId = HOST, actorId = WRITER) => `Placement:remix:${imageId}:${actorId}`;
/** Whether the writer still earns the remix on this image, by the ledger alone. */
const earning = (imageId = HOST) => engine.ledger.get(remixSource(imageId)) === 'add';

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "tosViolation" boolean NOT NULL DEFAULT false,
      "nsfwLevel" int NOT NULL DEFAULT 1, "publishedAt" timestamp(3), "modelVersionId" int,
      metadata jsonb
    );
    CREATE TABLE "Storyline" (
      id int PRIMARY KEY, "userId" int NOT NULL, "sparkImageId" int,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "StorylineChapter" (
      id serial PRIMARY KEY, "storylineId" int NOT NULL, "postId" int, "userId" int, depth int NOT NULL,
      "removedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "Placement" (
      id serial PRIMARY KEY, surface text, "targetType" text, "targetId" int, "placerId" int,
      status text
    );
  `);
  const raw = pgliteRaw(pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  // The two Prisma model reads the hooks make, as the SQL Prisma would send.
  dbMock.dbWrite.placement.count.mockImplementation((async ({ where }: { where: never }) => {
    const w = where as Record<string, unknown>;
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Placement" WHERE surface = $1 AND "targetType" = $2
       AND "targetId" = $3 AND "placerId" = $4 AND status = $5`,
      [w.surface, w.targetType, w.targetId, w.placerId, w.status]
    );
    return rows[0].n;
  }) as never);
  dbMock.dbWrite.placement.findMany.mockImplementation((async ({ where }: { where: never }) => {
    const ids = (where as { id: { in: number[] } }).id.in;
    const { rows } = await pg.query(
      `SELECT surface, "targetType", "targetId", "placerId" FROM "Placement" WHERE id = ANY($1)`,
      [ids]
    );
    return rows;
  }) as never);
  dbMock.dbWrite.storyline.findUnique.mockImplementation((async ({ where }: { where: never }) => {
    const { rows } = await pg.query(
      `SELECT "userId", "sparkImageId" FROM "Storyline" WHERE id = $1`,
      [(where as { id: number }).id]
    );
    return rows[0] ?? null;
  }) as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
});

afterAll(async () => {
  await pg.close();
});

const sets = new Map<string, Set<string>>();
const locks = new Map<string, string>();

beforeEach(async () => {
  vi.clearAllMocks();
  engine.reset();
  sets.clear();
  redisMock.sysRedis.sMembers.mockImplementation((async (key: string) => [
    ...(sets.get(key) ?? []),
  ]) as never);
  redisMock.sysRedis.sAdd.mockImplementation((async (key: string, member: string) => {
    const set = sets.get(key) ?? new Set<string>();
    sets.set(key, set);
    const had = set.has(member);
    set.add(member);
    return had ? 0 : 1;
  }) as never);
  redisMock.sysRedis.sRem.mockImplementation((async (key: string, member: string) =>
    sets.get(key)?.delete(member) ? 1 : 0) as never);
  // The cap lock's two commands: SET NX takes it, the compare-and-delete script gives it back.
  locks.clear();
  redisMock.redis.set.mockImplementation((async (
    key: string,
    value: string,
    opts?: { NX?: boolean }
  ) => {
    if (opts?.NX && locks.has(key)) return null;
    locks.set(key, value);
    return 'OK';
  }) as never);
  redisMock.redis.eval.mockImplementation((async (
    _script: string,
    { keys: [key], arguments: [value] }: { keys: string[]; arguments: string[] }
  ) => (locks.get(key) === value && locks.delete(key) ? 1 : 0)) as never);
  events.list = [{ scoring: { storySparksPerActorPerDay: 3 } }];
  await pg.exec(`
    TRUNCATE "User", "Image", "Post", "Storyline", "StorylineChapter", "Placement";
    INSERT INTO "User" (id) VALUES (1), (2);
  `);
  await image(HOST);
});

async function image(id: number, { owner = OWNER, hatted = true } = {}) {
  await pg.query(`INSERT INTO "Image" VALUES ($1, $2)`, [id, owner]);
  if (hatted) engine.hatted.add(id);
}

let nextId = 1;
/** A storyline by `writer` started from `spark`, with chapter 1 written from a post of theirs. */
async function story({
  spark = HOST,
  writer = WRITER,
  publishedAt = new Date(Date.now() - 60_000),
  startedAt = new Date(),
  takenDown = false,
  modelVersionId = null,
}: {
  spark?: number;
  writer?: number;
  publishedAt?: Date | null;
  startedAt?: Date;
  takenDown?: boolean;
  modelVersionId?: number | null;
} = {}) {
  const id = nextId++;
  await pg.query(
    `INSERT INTO "Post" (id, "userId", "publishedAt", "modelVersionId") VALUES ($1, $2, $3, $4)`,
    [id, writer, publishedAt, modelVersionId]
  );
  await pg.query(`INSERT INTO "Storyline" VALUES ($1, $2, $3, $4)`, [id, writer, spark, takenDown]);
  await pg.query(
    `INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth, "createdAt")
     VALUES ($1, $1, $2, 0, $3)`,
    [id, writer, startedAt]
  );
  return id;
}

async function remix(status = 'approved') {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "Placement" (surface, "targetType", "targetId", "placerId", status)
     VALUES ('remixGallery', 'image', $1, $2, $3) RETURNING id`,
    [HOST, WRITER, status]
  );
  return rows[0].id;
}
const takeDownRemix = async (id: number) => {
  await pg.query(`UPDATE "Placement" SET status = 'removed' WHERE id = $1`, [id]);
  await onPlacementsTakenDown([id]);
};
const removeChapterOne = async (storylineId: number) => {
  await pg.query(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE "storylineId" = $1`, [
    storylineId,
  ]);
  await onStorySparkLost(storylineId);
};

describe('onStorySparked', () => {
  it("scores a live story from someone else's hatted image as its remix, for the writer", async () => {
    await onStorySparked(await story());
    expect(engine.awardEventPoints).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'remix',
        actorId: WRITER,
        entityType: 'Image',
        entityId: HOST,
        sourceId: remixSource(),
      }),
    ]);
  });

  it('never scores a story from your own image', async () => {
    await onStorySparked(await story({ writer: OWNER }));
    expect(engine.awardEventPoints).not.toHaveBeenCalled();
  });

  it.each([
    ['chapter 1 is not published yet', { publishedAt: new Date(Date.now() + 3_600_000) }],
    ['chapter 1 is a draft', { publishedAt: null }],
    ['the storyline is taken down', { takenDown: true }],
  ])('does not score while %s', async (_why, opts) => {
    await onStorySparked(await story(opts));
    expect(engine.awardEventPoints).not.toHaveBeenCalled();
  });

  it('does not score a story whose chapter 1 was removed', async () => {
    const id = await story();
    await pg.query(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE "storylineId" = $1`, [
      id,
    ]);
    await onStorySparked(id);
    expect(engine.awardEventPoints).not.toHaveBeenCalled();
  });

  it('does not score a story from an image with no hat', async () => {
    engine.hatted.delete(HOST);
    await onStorySparked(await story());
    expect(engine.awardEventPoints).not.toHaveBeenCalled();
  });

  it('scores nothing when no event sets a daily limit for stories', async () => {
    events.list = [{ scoring: {} }];
    await onStorySparked(await story());
    expect(engine.awardEventPoints).not.toHaveBeenCalled();
  });

  it("stops at the day's limit, counting every story that scored today", async () => {
    for (const id of [201, 202, 203, 205]) await image(id);
    await image(204, { hatted: false });
    await onStorySparked(await story({ spark: 201 }));
    await onStorySparked(await story({ spark: 204 })); // no hat: did not score, so does not count
    const down = await story({ spark: 202 });
    await onStorySparked(down);
    await pg.query(`UPDATE "Storyline" SET "tosViolation" = true WHERE id = $1`, [down]);
    await onStorySparkLost(down); // scored, then taken down: its slot stays used
    await onStorySparked(await story({ spark: 203 }));
    expect(engine.adds).toEqual([201, 202, 203].map((id) => remixSource(id)));

    // 201, 202 and 203: the limit is reached.
    await onStorySparked(await story({ spark: 205 }));
    expect(earning(205)).toBe(false);
  });

  it('deleting a story that scored does not free its slot while the remix it earned stays', async () => {
    events.list = [{ scoring: { storySparksPerActorPerDay: 1 } }];
    await image(201);
    const a = await story();
    await onStorySparked(a); // HOST scores: the day's one slot
    await onStorySparked(await story()); // HOST again: a repeat, no slot
    await pg.query(`DELETE FROM "StorylineChapter" WHERE "storylineId" = $1`, [a]);
    await pg.query(`DELETE FROM "Storyline" WHERE id = $1`, [a]);
    await onStorySparkRemoved({ actorId: WRITER, imageId: HOST });
    expect(earning()).toBe(true); // the second story still earns it
    await onStorySparked(await story({ spark: 201 }));
    expect(earning(201)).toBe(false);
  });

  it("parallel stories from one writer score no more than the day's limit", async () => {
    const sparks = [201, 202, 203, 204, 205, 206];
    for (const id of sparks) await image(id);
    const ids = [];
    for (const spark of sparks) ids.push(await story({ spark }));
    await Promise.all(ids.map((id) => onStorySparked(id)));
    expect(engine.adds).toHaveLength(3);
  });

  it('gives the slot back when the award records nothing or fails', async () => {
    for (const id of [201, 202, 203, 204]) await image(id);
    engine.awardEventPoints.mockResolvedValueOnce(0);
    await onStorySparked(await story({ spark: 201 }));
    engine.awardEventPoints.mockRejectedValueOnce(new Error('engine down'));
    await onStorySparked(await story({ spark: 202 }));
    for (const spark of [203, 204]) await onStorySparked(await story({ spark }));
    expect(engine.adds).toEqual([203, 204].map((id) => remixSource(id)));
    expect([...(sets.values().next().value ?? [])]).toHaveLength(2);
  });

  it("a story whose remix the writer already holds uses none of the day's slots", async () => {
    for (const id of [201, 202]) await image(id);
    await onStorySparked(await story({ spark: 201 }));
    await onStorySparked(await story()); // HOST scores
    await onStorySparked(await story()); // HOST again: a repeat
    await onStorySparked(await story({ spark: 202 }));
    expect(earning(202)).toBe(true);
  });

  it('starts a fresh limit at 00:00 UTC', async () => {
    events.list = [{ scoring: { storySparksPerActorPerDay: 1 } }];
    for (const id of [201, 202]) await image(id);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T23:59:00.000Z'));
      await onStorySparked(await story({ spark: 201 })); // the day's one slot
      await onStorySparked(await story({ spark: 202 })); // over the limit
      expect(earning(202)).toBe(false);
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      await onStorySparked(await story({ spark: 202 }));
      expect(earning(202)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('removal', () => {
  it('takes the remix back when the story was the only thing earning it', async () => {
    const id = await story();
    await onStorySparked(id);
    expect(earning()).toBe(true);
    await removeChapterOne(id);
    expect(earning()).toBe(false);
  });

  it('keeps it while an approved remix of the image still earns it', async () => {
    const id = await story();
    await remix();
    await onStorySparked(id);
    await removeChapterOne(id);
    expect(engine.removeEventPoints).not.toHaveBeenCalled();
    expect(earning()).toBe(true);
  });

  it("keeps it while another of the writer's stories from the image is live", async () => {
    const first = await story();
    await story();
    await onStorySparked(first);
    await removeChapterOne(first);
    expect(engine.removeEventPoints).not.toHaveBeenCalled();
  });

  // The remix earns first, so the story's award is a repeat that writes nothing. Only one shared
  // sourceId lets the story's removal net out the remix's add.
  it('remix scored, story added, remix removed, story removed last: nothing earns', async () => {
    const placement = await remix();
    await engine.awardEventPoints([
      {
        type: 'remix',
        actorId: WRITER,
        entityType: 'Image',
        entityId: HOST,
        sourceId: remixSource(),
      },
    ]);
    const id = await story();
    await onStorySparked(id);

    await takeDownRemix(placement);
    expect(engine.removeEventPoints).not.toHaveBeenCalled();
    expect(earning()).toBe(true);

    await removeChapterOne(id);
    expect(earning()).toBe(false);
  });

  it("takes it back when chapter 1's post is deleted", async () => {
    const id = await story();
    await onStorySparked(id);
    // The chapter's post foreign key is ON DELETE SET NULL.
    await pg.query(`UPDATE "StorylineChapter" SET "postId" = NULL WHERE "storylineId" = $1`, [id]);
    await pg.query(`DELETE FROM "Post" WHERE id = $1`, [id]);
    await onStorySparkLost(id);
    expect(earning()).toBe(false);
  });

  it('takes it back when the storyline is deleted', async () => {
    const id = await story();
    await onStorySparked(id);
    await pg.query(`DELETE FROM "StorylineChapter" WHERE "storylineId" = $1`, [id]);
    await pg.query(`DELETE FROM "Storyline" WHERE id = $1`, [id]);
    await onStorySparkRemoved({ actorId: WRITER, imageId: HOST });
    expect(earning()).toBe(false);
  });

  it('takes it back when the storyline is taken down', async () => {
    const id = await story();
    await onStorySparked(id);
    await pg.query(`UPDATE "Storyline" SET "tosViolation" = true WHERE id = $1`, [id]);
    await onStorySparkLost(id);
    expect(earning()).toBe(false);
  });
});

// Moderation and account writes that stop chapter 1 being shown, without touching the storyline.
describe('chapter 1 hidden by moderation', () => {
  const sparked = async (opts: Parameters<typeof story>[0] = {}) => {
    const id = await story(opts);
    await onStorySparked(id);
    expect(earning()).toBe(true);
    return id;
  };

  it('takes it back when a moderator unpublishes chapter 1 (the CSAM hold decision)', async () => {
    const id = await sparked();
    await unpublishPostAsModerator({ id, userId: 99, reason: 'csam-text-hold' });
    // The hook is fire-and-forget after the write.
    await vi.waitFor(() => expect(earning()).toBe(false));
  });

  it('takes it back when chapter 1 is rated Blocked', async () => {
    const id = await sparked();
    await pg.query(`UPDATE "Post" SET "nsfwLevel" = 32 WHERE id = $1`, [id]);
    await onStorySparkPostsHidden({ postIds: [id] });
    expect(earning()).toBe(false);
  });

  it("takes it back when chapter 1's model version is unpublished", async () => {
    await sparked({ modelVersionId: 77 });
    await pg.query(`UPDATE "Post" SET "publishedAt" = NULL WHERE "modelVersionId" = 77`);
    await onStorySparkPostsHidden({ modelVersionIds: [77] });
    expect(earning()).toBe(false);
  });

  it.each([
    ['banned', `"bannedAt"`],
    ['deleted', `"deletedAt"`],
  ])("takes it back when chapter 1's author is %s", async (_why, column) => {
    await sparked();
    await pg.query(`UPDATE "User" SET ${column} = now() WHERE id = $1`, [WRITER]);
    await onStorySparkPostsHidden({ authorId: WRITER });
    expect(earning()).toBe(false);
  });

  it('keeps it when the hidden post is not chapter 1 of the story that earns it', async () => {
    const id = await sparked();
    await onStorySparkPostsHidden({ postIds: [id] }); // nothing changed: still live
    await onStorySparkPostsHidden({ postIds: [999] });
    expect(engine.removeEventPoints).not.toHaveBeenCalled();
    expect(earning()).toBe(true);
  });
});

// The writes that show chapter 1 again: what a hide took, a restore gives back.
describe('chapter 1 shown again', () => {
  const hidden = async (opts: Parameters<typeof story>[0] = {}) => {
    const id = await story(opts);
    await onStorySparked(id);
    await pg.query(`UPDATE "Post" SET "publishedAt" = NULL WHERE id = $1`, [id]);
    await onStorySparkPostsHidden({ postIds: [id] });
    expect(earning()).toBe(false);
    return id;
  };
  const republish = (id: number) =>
    pg.query(`UPDATE "Post" SET "publishedAt" = now() - interval '1 minute' WHERE id = $1`, [id]);

  it('gives the remix back when chapter 1 is published again', async () => {
    const id = await hidden();
    await republish(id);
    await onStorySparkPostsRestored({ postIds: [id] });
    expect(earning()).toBe(true);
  });

  it("gives it back when chapter 1's model version is published again", async () => {
    const id = await hidden({ modelVersionId: 77 });
    await republish(id);
    await onStorySparkPostsRestored({ modelVersionIds: [77] });
    expect(earning()).toBe(true);
  });

  it("gives it back when chapter 1's author is unbanned", async () => {
    await onStorySparked(await story());
    await pg.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [WRITER]);
    await onStorySparkPostsHidden({ authorId: WRITER });
    await pg.query(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [WRITER]);
    await onStorySparkPostsRestored({ authorId: WRITER });
    expect(earning()).toBe(true);
  });

  it('awards once when the same restore runs twice', async () => {
    const id = await hidden();
    await republish(id);
    await onStorySparkPostsRestored({ postIds: [id] });
    await onStorySparkPostsRestored({ postIds: [id] });
    // The repeat asks for the same first, which the engine records once (one first per person,
    // type and entity: types.ts).
    const awards = engine.awardEventPoints.mock.calls.map(([actions]) =>
      actions.map(({ time: _time, ...rest }) => rest)
    );
    expect(awards).toHaveLength(3); // the first spark, then each restore
    expect(awards[2]).toEqual(awards[1]);
  });

  it('gives nothing back while chapter 1 is still hidden', async () => {
    const id = await hidden();
    await onStorySparkPostsRestored({ postIds: [id] });
    expect(earning()).toBe(false);
  });

  it('gives it back on the same day, on the slot it already used', async () => {
    const id = await hidden();
    for (const spark of [201, 202]) {
      await image(spark);
      await onStorySparked(await story({ spark }));
    }
    await republish(id);
    await onStorySparkPostsRestored({ postIds: [id] });
    expect(earning()).toBe(true);
  });

  it("gives nothing back on a later day once that day's limit is used", async () => {
    const id = await hidden();
    sets.clear(); // a new UTC day: a fresh scored set
    for (const spark of [201, 202, 203]) {
      await image(spark);
      await onStorySparked(await story({ spark }));
    }
    await republish(id);
    await onStorySparkPostsRestored({ postIds: [id] });
    expect(earning()).toBe(false);
  });
});
