import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import {
  eligibleRows,
  hashOf,
  planIsCurrent,
  preImage,
  writeReschedule,
  type RescheduleRow,
} from '~/server/games/daily-challenge/daily-reschedule';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let db: PGlite;

// id: what makes it (in)eligible. Every row but 1 and 2 breaks exactly one guard condition.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, source text, status text, "startsAt" timestamp, "visibleAt" timestamp,
      "collectionId" int, title text, description text, theme text, invitation text,
      "judgeId" int, "judgingEngine" text DEFAULT 'legacy-absolute', "judgingCategories" jsonb,
      metadata jsonb
    );
    CREATE TABLE "CollectionItem" (id int, "collectionId" int);
    INSERT INTO "Challenge" (id, source, status, "startsAt", "visibleAt", "collectionId", metadata) VALUES
      (1, 'System', 'Scheduled', now() + interval '5 days', now() + interval '2 days', 10, '{}'),
      (2, 'System', 'Scheduled', now() + interval '2 days', now() - interval '1 day', 20, '{}'),
      (3, 'System', 'Scheduled', now() - interval '1 hour', now() - interval '4 days', 30, '{}'),
      (4, 'System', 'Scheduled', now() + interval '5 days', now() + interval '2 days', 40, '{}'),
      (5, 'System', 'Active', now() + interval '5 days', now() + interval '2 days', 50, '{}'),
      (6, 'Mod', 'Scheduled', now() + interval '5 days', now() + interval '2 days', 60, '{}'),
      (7, 'System', 'Scheduled', now() + interval '6 days', now() + interval '3 days', 70,
        '{"dailyPlan": {"setKey": "story", "source": "schedule", "judgeName": "x"}}');
    INSERT INTO "CollectionItem" VALUES (1, 40);
  `);
});
afterAll(() => db.close());

const toSql = (strings: TemplateStringsArray, values: unknown[]) =>
  Prisma.sql(strings, ...(values as never[]));

beforeEach(() => {
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = toSql(strings, values);
    return (await db.query(sql.text, sql.values as unknown[])).rows;
  }) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(query);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(query);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = toSql(strings, values);
    return (await db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
  }) as never);
});

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe('eligibleRows', () => {
  it('lists only not-yet-visible, not-started, unentered Scheduled System dailies', async () => {
    expect(ids(await eligibleRows({}, false))).toEqual([1, 7]);
  });

  it('rubricOnly also allows a visible daily that has not started', async () => {
    expect(ids(await eligibleRows({}, true))).toEqual([2, 1, 7]);
  });

  it('limits to the from/to range by start date', async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    // Row 1 starts in 5 days, row 7 in 6.
    expect(ids(await eligibleRows({ from: day(6), to: day(6) }, false))).toEqual([7]);
  });

  it('never widens past the guard when ids are given', async () => {
    expect(ids(await eligibleRows({ ids: [2, 3, 4, 5, 6] }, false))).toEqual([]);
  });
});

describe('planIsCurrent', () => {
  const planned = (setKey: string, judgeName: string) => ({
    metadata: { dailyPlan: { setKey, source: 'schedule', judgeName } },
  });

  it('is current when set and judge match', () => {
    expect(
      planIsCurrent(planned('story', 'Jolly CivBot'), {
        setKey: 'story',
        judgeName: 'Jolly CivBot',
      })
    ).toBe(true);
  });

  it('is not current for a row planned while its judge was missing', () => {
    expect(
      planIsCurrent(planned('story', 'default'), { setKey: 'story', judgeName: 'Jolly CivBot' })
    ).toBe(false);
  });

  it('is not current for a row with no plan', () => {
    expect(planIsCurrent({ metadata: {} }, { setKey: 'story', judgeName: 'Jolly CivBot' })).toBe(
      false
    );
  });
});

describe('writeReschedule', () => {
  const article = {
    title: 'New title',
    description: '<p>New</p>',
    theme: 'Snow globe',
    invitation: 'Shake it',
    themeElements: ['glass dome'],
  };
  const write = (challengeId: number, preImageHash: string) =>
    writeReschedule({
      challengeId,
      preImageHash,
      rubricOnly: false,
      article,
      judgeId: 9,
      judgingEngine: 'legacy-absolute',
      judgingCategories: [{ key: 'theme', weight: 100 }],
      dailyPlan: { setKey: 'cute', source: 'schedule', judgeName: 'Jolly CivBot' },
    });
  const fetchRow = async (id: number) =>
    (await db.query<RescheduleRow>(`SELECT * FROM "Challenge" WHERE id = $1`, [id])).rows[0];

  it('updates an eligible row with the reviewed proposal', async () => {
    const [row] = await eligibleRows({ ids: [1] }, false);

    expect(await write(1, hashOf(preImage(row)))).toBe('updated');

    const after = await fetchRow(1);
    expect(after.theme).toBe('Snow globe');
    expect(after.judgeId).toBe(9);
    expect(after.metadata).toMatchObject({
      themeElements: ['glass dome'],
      dailyPlan: { setKey: 'cute' },
    });
  });

  it('refuses a row that changed since the dry run', async () => {
    const [row] = await eligibleRows({ ids: [7] }, false);
    const hash = hashOf(preImage(row));
    await db.query(`UPDATE "Challenge" SET title = 'edited by a mod' WHERE id = 7`);

    expect(await write(7, hash)).toBe('row changed since the dry run');
    expect((await fetchRow(7)).title).toBe('edited by a mod');
  });

  it('rubricOnly keeps the published article and changes only rubric and judge', async () => {
    await db.query(
      `INSERT INTO "Challenge" (id, source, status, "startsAt", "visibleAt", "collectionId", title, theme, metadata)
       VALUES (8, 'System', 'Scheduled', now() + interval '1 day', now() - interval '1 day', 80, 'Live title',
               'Live theme', '{"themeElements": ["kept"]}')`
    );
    const [row] = await eligibleRows({ ids: [8] }, true);

    const result = await writeReschedule({
      challengeId: 8,
      preImageHash: hashOf(preImage(row)),
      rubricOnly: true,
      article,
      judgeId: 9,
      judgingEngine: 'legacy-absolute',
      judgingCategories: [{ key: 'theme', weight: 100 }],
      dailyPlan: { setKey: 'cute', source: 'schedule', judgeName: 'Jolly CivBot' },
    });

    expect(result).toBe('updated');
    const after = await fetchRow(8);
    expect([after.title, after.theme]).toEqual(['Live title', 'Live theme']);
    expect(after.judgingCategories).toEqual([{ key: 'theme', weight: 100 }]);
    expect(after.metadata).toMatchObject({ themeElements: ['kept'] });
  });

  it('dailyPlan null removes the stored plan and keeps other metadata', async () => {
    await db.query(
      `INSERT INTO "Challenge" (id, source, status, "startsAt", "visibleAt", "collectionId", metadata)
       VALUES (9, 'System', 'Scheduled', now() + interval '8 days', now() + interval '5 days', 90,
               '{"themeElements": ["kept"], "dailyPlan": {"setKey": "story", "source": "schedule", "judgeName": "x"}}')`
    );
    const [row] = await eligibleRows({ ids: [9] }, true);

    const result = await writeReschedule({
      challengeId: 9,
      preImageHash: hashOf(preImage(row)),
      rubricOnly: true,
      judgeId: 1,
      judgingEngine: 'legacy-absolute',
      judgingCategories: [{ key: 'theme', weight: 100 }],
      dailyPlan: null,
    });

    expect(result).toBe('updated');
    const { metadata } = await fetchRow(9);
    expect(metadata).toEqual({ themeElements: ['kept'] });
  });

  it.each([
    [2, 'visible'],
    [3, 'started'],
    [4, 'entered'],
    [5, 'Active'],
    [6, 'Mod source'],
  ])('leaves row %i (%s) untouched', async (id) => {
    const before = await fetchRow(id);

    expect(await write(id, '0'.repeat(64))).toMatch(/^not eligible/);
    expect(await fetchRow(id)).toEqual(before);
  });
});
