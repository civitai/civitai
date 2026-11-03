import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as Award from '~/server/events/points/award';
import type { EventPointAction, EventPointRemoval } from '~/server/events/points/types';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A story started from a hatted image scores as that image's remix. Which stories count is SQL (live
 * chapter 1, not taken down, not your own image, the day's limit), so it runs against Postgres. The
 * engine is a small fake of its contract (types.ts): one first per (type, entity, person), a ledger
 * keyed by sourceId, an earning counting while that id's latest row is an add.
 */

const engine = vi.hoisted(() => {
  const seen = new Set<string>();
  const ledger = new Map<string, 'add' | 'remove'>();
  const hatted = new Set<number>();
  const firstKey = (a: { type: string; entityId: number; actorId: number }) =>
    `${a.type}:${a.entityId}:${a.actorId}`;
  return {
    seen,
    ledger,
    hatted,
    awardEventPoints: vi.fn(async (actions: EventPointAction[]) => {
      for (const a of actions) {
        if (seen.has(firstKey(a))) continue;
        seen.add(firstKey(a));
        ledger.set(a.sourceId ?? '', 'add');
      }
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

const { onPlacementsTakenDown, onStorySparked, onStorySparkLost, onStorySparkRemoved } =
  await import('~/server/events/points/hooks');

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
      "nsfwLevel" int NOT NULL DEFAULT 1, "publishedAt" timestamp(3)
    );
    CREATE TABLE "Storyline" (
      id int PRIMARY KEY, "userId" int NOT NULL, "sparkImageId" int,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "StorylineChapter" (
      id serial PRIMARY KEY, "storylineId" int NOT NULL, "postId" int, depth int NOT NULL,
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
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  engine.reset();
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
}: {
  spark?: number;
  writer?: number;
  publishedAt?: Date | null;
  startedAt?: Date;
  takenDown?: boolean;
} = {}) {
  const id = nextId++;
  await pg.query(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES ($1, $2, $3)`, [
    id,
    writer,
    publishedAt,
  ]);
  await pg.query(`INSERT INTO "Storyline" VALUES ($1, $2, $3, $4)`, [id, writer, spark, takenDown]);
  await pg.query(
    `INSERT INTO "StorylineChapter" ("storylineId", "postId", depth, "createdAt") VALUES ($1, $1, 0, $2)`,
    [id, startedAt]
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

  it("stops at the day's limit, counting only today's live stories on other hatted images", async () => {
    for (const id of [201, 202, 203]) await image(id);
    await image(204, { hatted: false });
    await image(205);
    await story({ spark: 201 });
    await story({ spark: 202 });
    await story({ spark: 204 }); // no hat: did not score, so does not count
    await story({ spark: 205, startedAt: new Date(Date.now() - 2 * 86_400_000) }); // another day
    await story({ spark: 203, takenDown: true }); // not live
    await onStorySparked(await story());
    expect(engine.awardEventPoints).toHaveBeenCalledTimes(1);

    // 201, 202 and the one just scored: the limit is reached.
    engine.awardEventPoints.mockClear();
    await image(206);
    await onStorySparked(await story({ spark: 206 }));
    expect(engine.awardEventPoints).not.toHaveBeenCalled();
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
    engine.awardEventPoints([
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
