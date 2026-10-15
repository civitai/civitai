import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countSelfImageEngagement,
  imagesScoreWithoutSelf,
  summariseScoreChanges,
  tierOf,
} from '~/server/services/creator-score-self-activity.service';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const OWNER = 1;
const FAN = 2;
const EARLY = '2026-01-01T00:00:00Z';
const LATE = '2026-06-01T00:00:00Z';
const CUTOFF = new Date('2026-03-01T00:00:00Z');

let nextId = 1;
async function image(userId: number) {
  const id = nextId++;
  await q(`INSERT INTO "Image" (id, "userId") VALUES ($1, $2)`, [id, userId]);
  return id;
}
const react = (imageId: number, userId: number, reaction = 'Like', createdAt = EARLY) =>
  q(
    `INSERT INTO "ImageReaction" ("imageId", "userId", reaction, "createdAt") VALUES ($1, $2, $3, $4)`,
    [imageId, userId, reaction, createdAt]
  );
async function comment(imageId: number, userId: number, createdAt = EARLY) {
  const thread = await q(`SELECT id FROM "Thread" WHERE "imageId" = $1`, [imageId]);
  let threadId = (thread.rows[0] as { id: number } | undefined)?.id;
  if (!threadId) {
    threadId = nextId++;
    await q(`INSERT INTO "Thread" (id, "imageId") VALUES ($1, $2)`, [threadId, imageId]);
  }
  await q(`INSERT INTO "CommentV2" ("threadId", "userId", "createdAt") VALUES ($1, $2, $3)`, [
    threadId,
    userId,
    createdAt,
  ]);
}

beforeAll(async () => {
  holder.db = new PGlite();
  await q(`CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int)`);
  await q(`CREATE TABLE "ImageReaction" (
    "imageId" int NOT NULL, "userId" int NOT NULL, reaction text NOT NULL, "createdAt" timestamp(3) NOT NULL
  )`);
  await q(`CREATE TABLE "Thread" (id int PRIMARY KEY, "imageId" int, "commentId" int)`);
  await q(`CREATE TABLE "CommentV2" (
    id serial PRIMARY KEY, "threadId" int NOT NULL, "userId" int NOT NULL, "createdAt" timestamp(3) NOT NULL
  )`);
});

beforeEach(async () => {
  await q(`TRUNCATE "Image", "ImageReaction", "Thread", "CommentV2"`);
});

describe('countSelfImageEngagement', () => {
  it("counts the owner's own reactions on their own images, of every scored type", async () => {
    const a = await image(OWNER);
    const b = await image(OWNER);
    for (const reaction of ['Like', 'Heart', 'Laugh', 'Cry']) await react(a, OWNER, reaction);
    await react(b, OWNER);
    const counts = await countSelfImageEngagement(pg, [OWNER], CUTOFF);
    expect(counts.get(OWNER)).toEqual({ reactions: 5, comments: 0 });
  });

  it("leaves out others' reactions, the owner's reactions on others' images, and Dislike", async () => {
    const own = await image(OWNER);
    const theirs = await image(FAN);
    await react(own, FAN);
    await react(theirs, OWNER);
    await react(own, OWNER, 'Dislike');
    await react(own, OWNER);
    const counts = await countSelfImageEngagement(pg, [OWNER, FAN], CUTOFF);
    expect(counts.get(OWNER)).toEqual({ reactions: 1, comments: 0 });
    expect(counts.has(FAN)).toBe(false);
  });

  it("counts the owner's own top-level comments on their images only", async () => {
    const own = await image(OWNER);
    const theirs = await image(FAN);
    await comment(own, OWNER);
    await comment(own, OWNER);
    await comment(own, FAN);
    await comment(theirs, OWNER);
    // A reply lives in a thread hung off the comment, not the image, and is not image engagement.
    await q(`INSERT INTO "Thread" (id, "commentId") VALUES (999, 1)`);
    await q(`INSERT INTO "CommentV2" ("threadId", "userId", "createdAt") VALUES (999, $1, $2)`, [
      OWNER,
      EARLY,
    ]);
    const counts = await countSelfImageEngagement(pg, [OWNER, FAN], CUTOFF);
    expect(counts.get(OWNER)).toEqual({ reactions: 0, comments: 2 });
    expect(counts.has(FAN)).toBe(false);
  });

  it('counts only engagement from before the cutoff', async () => {
    const own = await image(OWNER);
    await react(own, OWNER, 'Like', EARLY);
    await react(own, OWNER, 'Heart', LATE);
    await comment(own, OWNER, EARLY);
    await comment(own, OWNER, LATE);
    const counts = await countSelfImageEngagement(pg, [OWNER], CUTOFF);
    expect(counts.get(OWNER)).toEqual({ reactions: 1, comments: 1 });
  });

  it('counts only the owners asked for', async () => {
    const own = await image(OWNER);
    await react(own, OWNER);
    expect((await countSelfImageEngagement(pg, [FAN], CUTOFF)).size).toBe(0);
  });
});

describe('imagesScoreWithoutSelf', () => {
  const mult = { reactions: 10, comments: 20 };

  it('subtracts reactions and comments at their multipliers', () => {
    expect(imagesScoreWithoutSelf(1000, { reactions: 3, comments: 2 }, mult)).toBe(1000 - 30 - 40);
  });

  it('never goes below zero', () => {
    expect(imagesScoreWithoutSelf(50, { reactions: 10, comments: 0 }, mult)).toBe(0);
  });

  it('keeps the stored score when the owner has no self-engagement', () => {
    expect(imagesScoreWithoutSelf(500, undefined, mult)).toBe(500);
  });
});

describe('summariseScoreChanges', () => {
  const tiers = [
    { key: 'score:star', threshold: 100_000 },
    { key: 'score:supernova', threshold: 1_000_000 },
  ];

  it('places a total in the highest tier it reaches', () => {
    expect(tierOf(99_999, tiers)).toBe('none');
    expect(tierOf(100_000, tiers)).toBe('score:star');
    expect(tierOf(5_000_000, tiers)).toBe('score:supernova');
  });

  it('reports by stored tier, counts falls below it, and skips owners that do not move', () => {
    const stored = new Map([
      [1, { total: 1_010_000, images: 500_000, models: 510_000 }], // falls below supernova
      [2, { total: 2_000_000, images: 1_000_000, models: 1_000_000 }], // falls, stays supernova
      [3, { total: 150_000, models: 150_000 }], // unchanged
      [4, { total: 110_000, images: 20_000 }], // star, falls below star
    ]);
    const changes = new Map<number, { models?: number; images?: number }>([
      [1, { images: 480_000 }],
      [2, { images: 990_000, models: 999_000 }],
      [3, { models: 150_000 }],
      [4, { images: 0 }],
    ]);
    const { changed, byTier } = summariseScoreChanges(changes, stored, tiers);
    expect(changed.map(([id]) => id)).toEqual(['1', '2', '4']);
    expect(byTier).toEqual({
      'score:supernova': { up: 0, down: 2, belowTier: 1 },
      'score:star': { up: 0, down: 1, belowTier: 1 },
    });
  });

  it('measures the change against the stored categories, not a fresh sum of them', () => {
    // The stored total has drifted from its categories; only the images change is reported.
    const stored = new Map([[1, { total: 1_002_000, images: 400_000, models: 0 }]]);
    const { byTier } = summariseScoreChanges(new Map([[1, { images: 399_000 }]]), stored, tiers);
    expect(byTier).toEqual({ 'score:supernova': { up: 0, down: 1, belowTier: 0 } });
  });
});
