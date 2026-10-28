import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { harvestRulings } from './harvest.service';

const NOW = new Date('2026-12-15T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsTrialAnswer","KnightsTrialRun","KnightsReferenceImage","KnightsHarvestCursor","ModActivity","Image","Post" RESTART IDENTITY CASCADE`
  );
});

type ImageOpts = {
  level?: number;
  locked?: boolean;
  reason?: string | null;
  type?: string;
  ingestion?: string;
  blockedFor?: string | null;
  published?: boolean;
};

async function image(id: number, o: ImageOpts = {}) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [
    id,
    o.published === false ? null : '2020-01-01',
  ]);
  await pg.query(
    `INSERT INTO "Image" ("id","url","nsfwLevel","nsfwLevelLocked","metadata","type","ingestion","blockedFor","postId")
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$1)`,
    [
      id,
      `key-${id}`,
      o.level ?? 4,
      o.locked ?? true,
      JSON.stringify({ nsfwLevelReason: o.reason ?? null }),
      o.type ?? 'image',
      o.ingestion ?? 'Scanned',
      o.blockedFor ?? null,
    ]
  );
}

async function ruling(imageId: number, o: { activity?: string; ageDays?: number } = {}) {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "ModActivity" ("userId","activity","entityType","entityId","createdAt")
     VALUES (7,$1,'image',$2,$3) RETURNING "id"`,
    [o.activity ?? 'setNsfwLevel', imageId, daysAgo(o.ageDays ?? 1)]
  );
  return rows[0].id;
}

const references = async () =>
  (
    await pg.query<{ imageId: number; pool: string; answer: string; status: string }>(
      `SELECT "imageId","pool","answer","status","source" FROM "KnightsReferenceImage" ORDER BY "imageId"`
    )
  ).rows;

describe('harvestRulings', () => {
  it('takes a moderator ruling that still holds, with the level as the answer', async () => {
    await image(1, { level: 8 });
    const activity = await ruling(1);

    const result = await harvestRulings(db, { now: NOW });

    const [row] = (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsReferenceImage"`))
      .rows;
    expect(row).toMatchObject({
      imageId: 1,
      answer: '8',
      source: 'harvested',
      status: 'active',
      modActivityId: activity,
      questionKey: 'knights.image.nsfwLevel',
    });
    expect(['trials', 'hiddenCheck']).toContain(row.pool);
    expect(result.added).toBe(1);
  });

  it.each([
    ['a Knights vote lock', { reason: 'Knights Vote' }],
    ['an image nobody locked', { locked: false }],
    ['a Blocked rating', { level: 32 }],
    ['an unrated image', { level: 0 }],
    ['a blocked ingestion', { ingestion: 'Blocked' }],
    ['a blockedFor marker', { blockedFor: 'tos' }],
    ['an unpublished post', { published: false }],
    ['a non-image', { type: 'video' }],
  ] as const)('skips %s', async (_label, opts: ImageOpts) => {
    await image(1, opts);
    await ruling(1);
    await harvestRulings(db, { now: NOW });
    expect(await references()).toEqual([]);
  });

  it('skips Knights results and rulings too old to be fresh', async () => {
    await image(1);
    await image(2);
    await ruling(1, { activity: 'setNsfwLevelKono' });
    await ruling(2, { ageDays: 400 });
    await harvestRulings(db, { now: NOW });
    expect(await references()).toEqual([]);
  });

  it('skips an image rated again after the ruling, and keeps the latest ruling otherwise', async () => {
    await image(1);
    await image(2);
    await ruling(1);
    await ruling(1, { activity: 'setNsfwLevelKono' });
    await ruling(2);
    const latest = await ruling(2);
    await harvestRulings(db, { now: NOW });
    const rows = (
      await pg.query<{ imageId: number; modActivityId: number }>(
        `SELECT "imageId","modActivityId" FROM "KnightsReferenceImage"`
      )
    ).rows;
    expect(rows).toEqual([{ imageId: 2, modActivityId: latest }]);
  });

  it('puts each image in one pool and does nothing the second time', async () => {
    for (let id = 1; id <= 60; id++) {
      await image(id);
      await ruling(id);
    }
    await harvestRulings(db, { now: NOW });
    const first = await references();
    const second = await harvestRulings(db, { now: NOW });

    expect(first).toHaveLength(60);
    expect(new Set(first.map((r) => r.pool))).toEqual(new Set(['trials', 'hiddenCheck']));
    expect(second.added).toBe(0);
    expect(await references()).toEqual(first);
  });

  it('keeps an image already in a pool where it is, and leaves core alone', async () => {
    await image(1);
    await ruling(1);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","explanation")
       VALUES (1,'hiddenCheck','2','core','why')`
    );
    const result = await harvestRulings(db, { now: NOW });
    expect(result.added).toBe(0);
    expect(await references()).toMatchObject([{ imageId: 1, pool: 'hiddenCheck', answer: '2' }]);
  });

  it('reads only past the cursor', async () => {
    await image(1);
    await ruling(1);
    const first = await harvestRulings(db, { now: NOW });
    await pg.query(`DELETE FROM "KnightsReferenceImage"`);
    const second = await harvestRulings(db, { now: NOW });
    expect(first.scanned).toBe(1);
    expect(second.scanned).toBe(0);
    expect(await references()).toEqual([]);

    await image(2);
    await ruling(2);
    expect((await harvestRulings(db, { now: NOW })).added).toBe(1);
  });

  it('retires fresh items past their age, but never core', async () => {
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","harvestedAt")
       VALUES (1,'trials','4','harvested',$1), (2,'trials','4','harvested',$2), (3,'trials','4','core',$1)`,
      [daysAgo(100), daysAgo(1)]
    );
    await image(1);
    await image(2);
    await image(3);
    const result = await harvestRulings(db, { now: NOW });
    expect(result.retired).toBe(1);
    expect(
      (
        await pg.query<{ imageId: number; status: string }>(
          `SELECT "imageId","status" FROM "KnightsReferenceImage" ORDER BY "imageId"`
        )
      ).rows
    ).toEqual([
      { imageId: 1, status: 'retired' },
      { imageId: 2, status: 'active' },
      { imageId: 3, status: 'active' },
    ]);
  });

  it('retires a fresh item whose image has since moved or been blocked', async () => {
    await image(1, { level: 8 });
    await image(2, { level: 4, ingestion: 'Blocked' });
    await image(3, { level: 4 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES
       (1,'trials','4','harvested'), (2,'trials','4','harvested'), (3,'trials','4','harvested')`
    );
    await harvestRulings(db, { now: NOW });
    expect((await references()).map((r) => [r.imageId, r.status])).toEqual([
      [1, 'retired'],
      [2, 'retired'],
      [3, 'active'],
    ]);
  });
});
