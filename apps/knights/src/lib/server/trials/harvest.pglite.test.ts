import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { ensureVotePartitions } from '../queue/queue.service';
import { HARVEST } from './config';
import { harvestRulings, runHarvestJob } from './harvest.service';

const NOW = new Date('2026-12-15T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsHarvestCursor","ModActivity","Image","Post" RESTART IDENTITY CASCADE`
  );
});

type ImageOpts = {
  level?: number;
  locked?: boolean;
  reason?: string | null;
  type?: string;
  ingestion?: string;
  blockedFor?: string | null;
  needsReview?: string | null;
  acceptableMinor?: boolean;
  published?: boolean;
};

async function image(id: number, o: ImageOpts = {}) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [
    id,
    o.published === false ? null : '2020-01-01',
  ]);
  await pg.query(
    `INSERT INTO "Image" ("id","url","nsfwLevel","nsfwLevelLocked","metadata","type","ingestion","blockedFor","needsReview","acceptableMinor","postId")
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$1)`,
    [
      id,
      `key-${id}`,
      o.level ?? 4,
      o.locked ?? true,
      JSON.stringify({ nsfwLevelReason: o.reason ?? null }),
      o.type ?? 'image',
      o.ingestion ?? 'Scanned',
      o.blockedFor ?? null,
      o.needsReview ?? null,
      o.acceptableMinor ?? false,
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
    ['a moderator queue rating', { reason: 'Moderator queue rating' }],
    ['an image nobody locked', { locked: false }],
    ['a Blocked rating', { level: 32 }],
    ['an unrated image', { level: 0 }],
    ['a blocked ingestion', { ingestion: 'Blocked' }],
    ['a blockedFor marker', { blockedFor: 'tos' }],
    ['a review hold', { needsReview: 'minor' }],
    ['an acceptable-minor image', { acceptableMinor: true }],
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
    const split = { ...HARVEST, hiddenCheckShare: 0.3 };
    await harvestRulings(db, { now: NOW, config: split });
    const first = await references();
    const second = await harvestRulings(db, { now: NOW, config: split });

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
    await image(4, { level: 4, needsReview: 'minor' });
    await image(5, { level: 4, acceptableMinor: true });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES
       (1,'trials','4','harvested'), (2,'trials','4','harvested'), (3,'trials','4','harvested'),
       (4,'trials','4','harvested'), (5,'trials','4','harvested')`
    );
    await harvestRulings(db, { now: NOW });
    expect((await references()).map((r) => [r.imageId, r.status])).toEqual([
      [1, 'retired'],
      [2, 'retired'],
      [3, 'active'],
      [4, 'retired'],
      [5, 'retired'],
    ]);
  });

  it('checks the image gate only for the references it retires from, a chunk of ids at a time', async () => {
    for (const id of [1, 2, 3, 4, 5]) await image(id, { level: id === 2 || id === 5 ? 8 : 4 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","harvestedAt") VALUES
       (1,'trials','4','harvested',$1), (2,'trials','4','harvested',$1), (3,'trials','4','harvested',$2),
       (4,'trials','4','core',$1), (5,'trials','4','inquisitor',$2)`,
      [daysAgo(1), daysAgo(100)]
    );
    const gateReads: (readonly unknown[])[] = [];
    const watched = db.withPlugin({
      transformQuery: ({ node, queryId }) => {
        const { sql, parameters } = db.getExecutor().compileQuery(node, queryId);
        if (sql.includes('"KnightsImageGate"') && sql.includes('"KnightsReferenceImage"'))
          gateReads.push(parameters);
        return node;
      },
      transformResult: async ({ result }) => result,
    });
    const result = await harvestRulings(watched, {
      now: NOW,
      config: { ...HARVEST, retireGateChunk: 2 },
    });
    expect(result.retired).toBe(3);

    // The aged-out item (3) retires without the gate; 1, 2 and 5 are checked in chunks of 2; core (4) never is.
    expect(gateReads.map((params) => params.find(Array.isArray))).toEqual([
      [expect.any(Number), expect.any(Number)],
      [expect.any(Number)],
    ]);
    expect((await references()).map((r) => [r.imageId, r.status])).toEqual([
      [1, 'active'],
      [2, 'retired'],
      [3, 'retired'],
      [4, 'active'],
      [5, 'retired'],
    ]);
  });
});

describe('harvest defaults and the job switch', () => {
  it('sends every ruling to trials unless a hidden-check share is set', async () => {
    for (let id = 1; id <= 40; id++) {
      await image(id);
      await ruling(id);
    }
    await harvestRulings(db, { now: NOW });
    const pools = new Set((await references()).map((r) => r.pool));
    expect(pools).toEqual(new Set(['trials']));
  });

  it('never harvests an image again once its reference is retired, while a new image still comes in', async () => {
    await image(1, { level: 8 });
    await ruling(1);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status")
       VALUES (1,'hiddenCheck','8','harvested','retired')`
    );
    await image(2);
    await ruling(2);

    await harvestRulings(db, { now: NOW });

    expect(await references()).toMatchObject([
      { imageId: 1, pool: 'hiddenCheck', status: 'retired' },
      { imageId: 2, pool: 'trials', status: 'active' },
    ]);
  });

  it('reads and writes nothing while paused, so the cursor holds, and harvests once resumed', async () => {
    await image(1);
    await ruling(1);
    const cursor = async () =>
      (await pg.query(`SELECT "lastActivityId" FROM "KnightsHarvestCursor"`)).rows;

    const paused = await runHarvestJob(db, {
      now: NOW,
      settings: { paused: true, hiddenCheckShare: 1 },
    });
    expect(paused).toEqual({ paused: true, retired: 0, probation: { promoted: 0, retired: 0 } });
    expect(await references()).toEqual([]);
    expect(await cursor()).toEqual([]);

    const resumed = await runHarvestJob(db, {
      now: NOW,
      settings: { paused: false, hiddenCheckShare: 1 },
    });
    expect(resumed).toMatchObject({ scanned: 1, added: 1 });
    expect(await references()).toMatchObject([{ imageId: 1, pool: 'hiddenCheck' }]);
    expect(await cursor()).toHaveLength(1);
  });
});

describe('resuming past the window', () => {
  it('counts the rulings it skips because they aged out while it was paused', async () => {
    await image(1);
    await image(2);
    await pg.query(
      `INSERT INTO "KnightsHarvestCursor" ("name","lastActivityId") VALUES ('trials',0)`
    );
    await ruling(1, { ageDays: 20 });
    await ruling(2, { ageDays: 1 });

    const result = await harvestRulings(db, { now: NOW });

    expect(result).toMatchObject({ added: 1, skippedStale: 1 });
    expect(await references()).toMatchObject([{ imageId: 2 }]);
  });

  it('counts only rulings past the cursor, and each one once', async () => {
    await image(1);
    await image(2);
    const before = await ruling(1, { ageDays: 30 });
    await pg.query(
      `INSERT INTO "KnightsHarvestCursor" ("name","lastActivityId") VALUES ('trials',$1)`,
      [before]
    );
    await ruling(2, { ageDays: 20 });

    expect((await harvestRulings(db, { now: NOW })).skippedStale).toBe(1);
    expect((await harvestRulings(db, { now: NOW })).skippedStale).toBe(0);
  });

  it('reports nothing skipped on a first run, before any cursor exists', async () => {
    await image(1);
    await ruling(1, { ageDays: 20 });
    expect((await harvestRulings(db, { now: NOW })).skippedStale).toBe(0);
  });
});

describe('the paused harvest job', () => {
  it('still retires a reference whose ruling no longer stands', async () => {
    await image(1, { level: 8 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES (1,'hiddenCheck','4','harvested')`
    );
    await image(2, { level: 4 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES (2,'hiddenCheck','4','harvested')`
    );

    const result = await runHarvestJob(db, {
      now: NOW,
      settings: { paused: true, hiddenCheckShare: 0 },
    });

    expect(result).toEqual({ paused: true, retired: 1, probation: { promoted: 0, retired: 0 } });
    expect(await references()).toMatchObject([
      { imageId: 1, status: 'retired' },
      { imageId: 2, status: 'active' },
    ]);
  });
});

describe('mod-confirmed skill checks under the paused job', () => {
  const insert = (imageId: number, source: string, harvestedDaysAgo: number) =>
    pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","harvestedAt") VALUES ($1,'skillCheck','4',$2,$3)`,
      [imageId, source, daysAgo(harvestedDaysAgo)]
    );
  const run = () =>
    runHarvestJob(db, { now: NOW, settings: { paused: true, hiddenCheckShare: 0 } });

  it('never ages out an inquisitor check, while a harvested one of the same age still goes', async () => {
    await image(1, { level: 4 });
    await insert(1, 'inquisitor', HARVEST.freshMaxAgeDays + 5);
    await image(2, { level: 4 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","harvestedAt") VALUES (2,'trials','4','harvested',$1)`,
      [daysAgo(HARVEST.freshMaxAgeDays + 5)]
    );

    await run();

    expect(await references()).toMatchObject([
      { imageId: 1, status: 'active' },
      { imageId: 2, status: 'retired' },
    ]);
  });

  it('retires an inquisitor check once a moderator moves the image off its level', async () => {
    await image(1, { level: 8, reason: null });
    await insert(1, 'inquisitor', 1);
    await run();
    expect(await references()).toMatchObject([{ imageId: 1, status: 'retired' }]);
  });
});

describe('harvestRulings batching', () => {
  const small = { ...HARVEST, batchSize: 2, maxBatches: 3 };
  const cursor = async () =>
    (
      await pg.query<{ lastActivityId: number }>(
        `SELECT "lastActivityId" FROM "KnightsHarvestCursor"`
      )
    ).rows[0]?.lastActivityId;

  async function rulings(count: number) {
    const ids: number[] = [];
    for (let imageId = 1; imageId <= count; imageId++) {
      await image(imageId);
      ids.push(await ruling(imageId));
    }
    return ids;
  }

  it('walks batches until one comes back short, and stores the last id it read', async () => {
    const ids = await rulings(5);
    const result = await harvestRulings(db, { now: NOW, config: small });
    expect(result).toMatchObject({ scanned: 5, added: 5 });
    expect(await cursor()).toBe(ids[4]);
  });

  it('stops at maxBatches and stores the cursor where it stopped, then resumes from there', async () => {
    const ids = await rulings(8);
    const first = await harvestRulings(db, { now: NOW, config: small });
    expect(first).toMatchObject({ scanned: 6, added: 6 });
    expect(await cursor()).toBe(ids[5]);

    const second = await harvestRulings(db, { now: NOW, config: small });
    expect(second).toMatchObject({ scanned: 2, added: 2 });
    expect(await cursor()).toBe(ids[7]);
  });

  it('stores the cursor when the last batch it read was full', async () => {
    const ids = await rulings(4);
    await harvestRulings(db, { now: NOW, config: small });
    expect(await cursor()).toBe(ids[3]);
    expect((await harvestRulings(db, { now: NOW, config: small })).scanned).toBe(0);
  });
});

describe('harvestRulings with the spot-check on', () => {
  const spot = { ...HARVEST, spotCheck: true };

  it('holds a Trials item as pending but lets a hidden check straight in', async () => {
    await image(1);
    await ruling(1);
    await harvestRulings(db, { now: NOW, config: { ...spot, hiddenCheckShare: 0 } });
    await image(2);
    await ruling(2);
    await harvestRulings(db, { now: NOW, config: { ...spot, hiddenCheckShare: 1 } });

    expect(
      (
        await pg.query<{ imageId: number; pool: string; status: string }>(
          `SELECT "imageId","pool","status" FROM "KnightsReferenceImage" ORDER BY "imageId"`
        )
      ).rows
    ).toEqual([
      { imageId: 1, pool: 'trials', status: 'pending' },
      { imageId: 2, pool: 'hiddenCheck', status: 'active' },
    ]);
  });

  it('retires a pending item that nobody checked before it aged out', async () => {
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status","harvestedAt")
       VALUES (1,'trials','4','harvested','pending',$1)`,
      [daysAgo(100)]
    );
    await image(1);

    expect((await harvestRulings(db, { now: NOW, config: spot })).retired).toBe(1);
  });
});

describe('a moderator ruling on an image players agreed on', () => {
  const agreementRow = (imageId: number, status: string, answers = 0, answer = '4') =>
    pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status","answers")
       VALUES ($1,'hiddenCheck',$2,'agreement','knights.image.nsfwLevel',$3,$4)`,
      [imageId, answer, status, answers]
    );
  const row = async (imageId: number) =>
    (
      await pg.query<Record<string, unknown>>(
        `SELECT pool,status,answer,source,"modActivityId",answers,failures FROM "KnightsReferenceImage" WHERE "imageId"=$1`,
        [imageId]
      )
    ).rows;

  const vote = async (imageId: number, playerId: number, verdict: string) => {
    const { rows } = await pg.query<{ id: number }>(
      `SELECT id FROM "KnightsReferenceImage" WHERE "imageId"=$1`,
      [imageId]
    );
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict")
       VALUES ($1,$2,$3,'knights.image.nsfwLevel',$4,'Knight','4',1,$5)`,
      [-rows[0].id, playerId, NOW.toISOString(), imageId, verdict]
    );
  };

  it('replaces an agreement reference that never graded anyone, probation or retired from it', async () => {
    await image(1, { level: 8 });
    await agreementRow(1, 'probation');
    await vote(1, 100, 'inconclusive');
    await image(2, { level: 8 });
    await agreementRow(2, 'retired');
    await vote(2, 101, 'inconclusive');
    const first = await ruling(1);
    const second = await ruling(2);

    await harvestRulings(db, { now: NOW });

    for (const [imageId, activity] of [
      [1, first],
      [2, second],
    ]) {
      expect(await row(imageId)).toEqual([
        {
          pool: 'trials',
          status: 'active',
          answer: '8',
          source: 'harvested',
          modActivityId: activity,
          answers: 0,
          failures: 0,
        },
      ]);
    }
  });

  it('leaves a promoted agreement reference that graded players, even only as close, to retire when its image moves', async () => {
    await image(1, { level: 8 });
    await agreementRow(1, 'active', 1);
    await vote(1, 100, 'failed');
    await image(2, { level: 8 });
    await agreementRow(2, 'active', 1);
    await vote(2, 101, 'inconclusive');
    await ruling(1);
    await ruling(2);

    const result = await harvestRulings(db, { now: NOW });

    expect(result.retired).toBe(2);
    for (const imageId of [1, 2]) {
      expect(await row(imageId)).toEqual([
        expect.objectContaining({
          status: 'retired',
          answer: '4',
          source: 'agreement',
          modActivityId: null,
        }),
      ]);
    }
  });

  it('leaves a ruled reference alone, retired or not', async () => {
    await image(1, { level: 8 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status") VALUES (1,'hiddenCheck','4','harvested','knights.image.nsfwLevel','retired')`
    );
    await ruling(1);
    await harvestRulings(db, { now: NOW });
    expect(await row(1)).toEqual([
      expect.objectContaining({
        status: 'retired',
        answer: '4',
        source: 'harvested',
        modActivityId: null,
      }),
    ]);
  });
});

describe('references on a Private post', () => {
  it('are only hidden: a fresh item is not retired over it', async () => {
    await image(3, { level: 4 });
    await pg.query(`UPDATE "Post" SET availability = 'Private' WHERE id = 3`);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES (3,'trials','4','harvested')`
    );
    await harvestRulings(db, { now: NOW });
    expect((await references()).map((r) => [r.imageId, r.status])).toEqual([[3, 'active']]);
  });
});
