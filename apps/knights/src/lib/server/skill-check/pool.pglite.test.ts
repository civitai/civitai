import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { SKILL_CHECK_EXCLUSIONS } from './eligible';
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
    `TRUNCATE "KnightsReferenceImage","KnightsQueueItem","Image","Post","EvidenceHoldImage","EvidenceHoldPost","ImageReport","Report","ImageFlag","Appeal","TextScanHold" RESTART IDENTITY CASCADE`
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
    const cases: [string, (imageId: number) => Promise<unknown>][] = [
      [
        'a ToS violation',
        (id) => pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=$1`, [id]),
      ],
      [
        'an evidence hold on the image',
        (id) =>
          pg.query(`INSERT INTO "EvidenceHoldImage" ("imageId","userId") VALUES ($1,1)`, [id]),
      ],
      [
        'an evidence hold on its post',
        (id) => pg.query(`INSERT INTO "EvidenceHoldPost" ("postId","userId") VALUES ($1,1)`, [id]),
      ],
      [
        'a pending report',
        async (id) => {
          await pg.query(`INSERT INTO "Report" ("id","status") VALUES (50,'Pending')`);
          await pg.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (50,$1)`, [id]);
        },
      ],
      [
        'a prompt flag',
        (id) => pg.query(`INSERT INTO "ImageFlag" ("imageId","promptNsfw") VALUES ($1,true)`, [id]),
      ],
      [
        'a pending appeal',
        (id) =>
          pg.query(
            `INSERT INTO "Appeal" ("entityType","entityId","status") VALUES ('Image',$1,'Pending')`,
            [id]
          ),
      ],
      [
        'a pending text-scan hold on its post',
        (id) =>
          pg.query(
            `INSERT INTO "TextScanHold" ("entityType","entityId","status") VALUES ('Post',$1,'Pending')`,
            [id]
          ),
      ],
      [
        'an open Inquisitor item',
        (id) =>
          pg.query(
            `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status") VALUES ('knights.image.nsfwLevel',$1,'test','Inquisitor',1,'Inquisitor')`,
            [id]
          ),
      ],
    ];

    it('has one test per exclusion clause', () => {
      expect(cases).toHaveLength(SKILL_CHECK_EXCLUSIONS.length);
    });

    it.each(cases)('refuses an image with %s and writes nothing', async (_label, flag) => {
      await seedImage(pg, 1);
      await flag(1);
      expect(await add(1)).toBe('ineligible');
      expect(await rows()).toEqual([]);
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
