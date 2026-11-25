import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { eligibleRows, planIsCurrent } from '~/server/games/daily-challenge/daily-reschedule';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let db: PGlite;

// id: what makes it (in)eligible. Every row but 1 and 2 breaks exactly one guard condition.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, source text, status text, "startsAt" timestamp, "visibleAt" timestamp,
      "collectionId" int, title text, description text, theme text, invitation text,
      "judgeId" int, "judgingCategories" jsonb, metadata jsonb
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

beforeEach(() => {
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await db.query(sql.text, sql.values as unknown[]);
    return rows;
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
