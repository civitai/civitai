import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { SKILL_CHECK_EXCLUSIONS } from './eligible';
import {
  EXCLUSION_TABLES,
  exclusionCases,
  extraExclusionCases,
} from '../../../test/skill-check-exclusions';
import { addSkillCheck } from './pool';

const NOW = new Date('2026-12-15T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","Image","Post",${EXCLUSION_TABLES} RESTART IDENTITY CASCADE`
  );
});

type Row = {
  id: number;
  imageId: number;
  pool: string;
  source: string;
  status: string;
  answer: string;
  answers: number;
  failures: number;
};
const rows = async () =>
  (
    await pg.query<Row>(
      `SELECT id,"imageId",pool,source,status,answer,answers,failures FROM "KnightsReferenceImage" ORDER BY id`
    )
  ).rows;

const add = (imageId: number, answer = '8', cap = 500, at = NOW) =>
  db.transaction().execute((trx) => addSkillCheck(trx, { imageId, answer, cap, now: at }));

async function seedRef(
  imageId: number,
  { pool = 'trials', source = 'harvested', answer = '4' } = {}
) {
  const r = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status","answers","failures") VALUES ($1,$2,$3,$4,'active',7,3) RETURNING id`,
    [imageId, pool, answer, source]
  );
  return r.rows[0].id;
}

describe('addSkillCheck', () => {
  it('adds a confirmed image as an active inquisitor check with the mods level and no answers yet', async () => {
    await seedImage(pg, 1);
    expect(await add(1, '8')).toBe('added');
    expect(await rows()).toEqual([
      {
        id: 1,
        imageId: 1,
        pool: 'skillCheck',
        source: 'inquisitor',
        status: 'active',
        answer: '8',
        answers: 0,
        failures: 0,
      },
    ]);
  });

  it.each([
    ['trials', 'harvested'],
    ['hiddenCheck', 'harvested'],
    ['hiddenCheck', 'agreement'],
  ])('moves a %s %s reference into the pool, same row, counters reset', async (pool, source) => {
    await seedImage(pg, 1);
    const id = await seedRef(1, { pool, source });
    expect(await add(1, '8')).toBe('moved');
    expect(await rows()).toEqual([
      {
        id,
        imageId: 1,
        pool: 'skillCheck',
        source: 'inquisitor',
        status: 'active',
        answer: '8',
        answers: 0,
        failures: 0,
      },
    ]);
  });

  it('takes over a probation check from the agreement intake: the mod-confirmed row wins', async () => {
    await seedImage(pg, 1);
    const id = (
      await pg.query<{ id: number }>(
        `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status") VALUES (1,'hiddenCheck','4','agreement','probation') RETURNING id`
      )
    ).rows[0].id;
    expect(await add(1, '8')).toBe('moved');
    expect(await rows()).toEqual([
      {
        id,
        imageId: 1,
        pool: 'skillCheck',
        source: 'inquisitor',
        status: 'active',
        answer: '8',
        answers: 0,
        failures: 0,
      },
    ]);
  });

  it('keeps a check whose answers were already graded at another level, and moves one graded at the same level', async () => {
    await seedImage(pg, 1);
    await seedImage(pg, 2);
    const graded = await seedRef(1, { pool: 'hiddenCheck' });
    const same = await seedRef(2, { pool: 'hiddenCheck' });
    for (const ref of [graded, same])
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict") VALUES ($1,5,$2,'knights.image.nsfwLevel',0,'Knight','4',1,'correct')`,
        [-ref, NOW]
      );
    const before = (await rows()).find((r) => r.id === graded);
    expect(await add(1, '8')).toBe('kept-graded');
    expect((await rows()).find((r) => r.id === graded)).toEqual(before);
    expect(await add(2, '4')).toBe('moved');
  });

  it('never moves a core reference', async () => {
    await seedImage(pg, 1);
    await seedRef(1, { source: 'core' });
    const before = await rows();
    expect(await add(1, '8')).toBe('kept-core');
    expect(await rows()).toEqual(before);
  });

  it('retires exactly the oldest active check when the pool is full, and only skill checks', async () => {
    for (const id of [1, 2, 3, 4]) await seedImage(pg, id);
    await seedRef(4, { pool: 'hiddenCheck' });
    await add(1, '4', 2, new Date('2026-12-01T00:00:00Z'));
    await add(2, '4', 2, new Date('2026-12-02T00:00:00Z'));
    expect(await add(3, '4', 2, new Date('2026-12-03T00:00:00Z'))).toBe('added');

    const byImage = Object.fromEntries((await rows()).map((r) => [r.imageId, r.status]));
    expect(byImage).toEqual({ 1: 'retired', 2: 'active', 3: 'active', 4: 'active' });
  });

  it('retires down to a lowered cap on the next add', async () => {
    for (const id of [1, 2, 3, 4]) await seedImage(pg, id);
    for (const [id, day] of [
      [1, 1],
      [2, 2],
      [3, 3],
    ])
      await add(id, '4', 10, new Date(`2026-12-0${day}T00:00:00Z`));
    await add(4, '4', 2, new Date('2026-12-04T00:00:00Z'));

    const active = (await rows()).filter((r) => r.status === 'active').map((r) => r.imageId);
    expect(active.sort()).toEqual([3, 4]);
  });

  it('keeps the pool at the cap when adds race', async () => {
    const { db: serial, pg: pg2 } = await createQueueDb({ serialize: true });
    for (const id of [1, 2, 3, 4, 5]) await seedImage(pg2, id);
    await Promise.all(
      [1, 2, 3, 4, 5].map((id, i) =>
        serial.transaction().execute((trx) =>
          addSkillCheck(trx, {
            imageId: id,
            answer: '4',
            cap: 3,
            now: new Date(NOW.getTime() + i),
          })
        )
      )
    );
    const active = await pg2.query(
      `SELECT count(*)::int n FROM "KnightsReferenceImage" WHERE status='active'`
    );
    expect(active.rows[0]).toEqual({ n: 3 });
    await pg2.close();
  }, 30_000);

  it('refuses an image the public feeds would not show', async () => {
    await seedImage(pg, 1, { publishedAt: null });
    expect(await add(1)).toBe('ineligible');
    expect(await rows()).toEqual([]);
  });

  describe('safety exclusions at insert', () => {
    const cases = exclusionCases(() => pg);

    it('has one case per exclusion clause, by name', () => {
      expect(cases.map(([name]) => name)).toEqual(SKILL_CHECK_EXCLUSIONS.map((e) => e.name));
    });

    it.each(extraExclusionCases(() => pg))('refuses an image with %s', async (_label, flag) => {
      await seedImage(pg, 1);
      await flag(1);
      expect(await add(1)).toBe('ineligible');
      expect(await rows()).toEqual([]);
    });

    it.each(cases)('refuses an image with %s and writes nothing', async (_label, flag) => {
      await seedImage(pg, 1);
      await flag(1);
      expect(await add(1)).toBe('ineligible');
      expect(await rows()).toEqual([]);
    });

    it('refuses a banned uploader too, and counts a clean account, an unflagged model and a closed report as fine', async () => {
      await seedImage(pg, 1);
      await pg.query(`INSERT INTO "User" ("id","username","bannedAt") VALUES (43,'b',now())`);
      await pg.query(`UPDATE "Image" SET "userId"=43 WHERE id=1`);
      expect(await add(1)).toBe('ineligible');

      await seedImage(pg, 2);
      await pg.query(`INSERT INTO "User" ("id","username") VALUES (44,'ok')`);
      await pg.query(`UPDATE "Image" SET "userId"=44 WHERE id=2`);
      await pg.query(`INSERT INTO "Model" ("id","minor") VALUES (70,false)`);
      await pg.query(`INSERT INTO "ModelVersion" ("id","modelId") VALUES (71,70)`);
      await pg.query(`INSERT INTO "ImageResourceNew" ("imageId","modelVersionId") VALUES (2,71)`);
      expect(await add(2)).toBe('added');
    });

    it('fails closed: a check that cannot be read keeps the image out, without failing the caller', async () => {
      await seedImage(pg, 1);
      await pg.query(`ALTER TABLE "ImageFlag" RENAME TO "ImageFlagGone"`);
      try {
        expect(await add(1)).toBe('unreadable');
      } finally {
        await pg.query(`ALTER TABLE "ImageFlagGone" RENAME TO "ImageFlag"`);
      }
      expect(await rows()).toEqual([]);
    });

    it('takes a child tag on an image rated below R', async () => {
      await seedImage(pg, 1, { nsfwLevel: 2 });
      await pg.query(`INSERT INTO "TagsOnImageDetails" ("imageId","tagId") VALUES (1,5351)`);
      expect(await add(1, '2')).toBe('added');
    });

    it('does not count a closed report or a decided appeal', async () => {
      await seedImage(pg, 1);
      await pg.query(`INSERT INTO "Report" ("id","status") VALUES (51,'Actioned')`);
      await pg.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (51,1)`);
      await pg.query(
        `INSERT INTO "Appeal" ("entityType","entityId","status") VALUES ('Image',1,'Rejected')`
      );
      expect(await add(1)).toBe('added');
    });
  });
});
