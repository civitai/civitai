import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn(() => ({
    fetch: async () => ({}),
    bust: async () => undefined,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));

import { updateContentSettings } from '~/server/services/user.service';

// The committed, hand-applied data fix, executed as written: this pins what a human will run.
const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20260922220000_fold_red_browsing_level_into_column/migration.sql'
);
const applyMigration = () => db.exec(readFileSync(MIGRATION, 'utf8'));

type Row = { id: number; browsingLevel: number; settings: Record<string, unknown> };

// [id, column level, stored settings, expected column level after, expected red key left]
const cases: [number, number, Record<string, unknown>, number, boolean][] = [
  [1, 31, { redBrowsingLevel: 3, allowAds: false }, 3, false], // narrowed on red: kept
  [2, 3, { redBrowsingLevel: 31 }, 3, false], // wider on red: column wins
  [3, 30, { redBrowsingLevel: 50 }, 18, false], // partly overlapping: intersection
  [4, 31, { redBrowsingLevel: 0 }, 1, false], // everything deselected on red: PG
  [5, 1, { redBrowsingLevel: 0 }, 1, false],
  [6, 3, { redBrowsingLevel: 4 }, 4, false], // no shared bit: red wins
  [7, 7, { redBrowsingLevel: 'high' }, 7, true], // not a number: untouched
  [8, 7, { redBrowsingLevel: 3.5 }, 7, true], // not a whole number: untouched
  [9, 7, { redBrowsingLevel: -1 }, 7, true], // negative: untouched
  [10, 15, { allowAds: true }, 15, false], // no red level at all: untouched
  [11, 7, { redBrowsingLevel: '3' }, 7, true], // a numeric STRING: untouched
  [12, 7, { redBrowsingLevel: 99999999999 }, 7, true], // beyond int: untouched, no abort
];

let db: PGlite;

async function insert(id: number, level: number, settings: Record<string, unknown>) {
  await db.query(`INSERT INTO "User" (id, "browsingLevel", settings) VALUES ($1, $2, $3::jsonb)`, [
    id,
    level,
    JSON.stringify(settings),
  ]);
}
async function read(id: number) {
  const rows = await db.query<Row>(
    `SELECT id, "browsingLevel", settings FROM "User" WHERE id = $1`,
    [id]
  );
  return rows.rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY,
      "browsingLevel" int NOT NULL DEFAULT 1,
      settings jsonb DEFAULT '{}'::jsonb
    );
  `);
});

afterAll(async () => {
  await db?.close();
});

describe('fold_red_browsing_level_into_column', () => {
  let after: Map<number, Row>;

  beforeAll(async () => {
    for (const [id, level, settings] of cases) await insert(id, level, settings);
    await applyMigration();
    const rows = await db.query<Row>(`SELECT id, "browsingLevel", settings FROM "User"`);
    after = new Map(rows.rows.map((r) => [r.id, r]));
  });

  it.each(cases)(
    'user %i: column %i with %o becomes %i',
    (id, _before, settings, level, keyLeft) => {
      const row = after.get(id)!;
      expect(row.browsingLevel).toBe(level);
      expect('redBrowsingLevel' in row.settings).toBe(keyLeft);
      // Other settings survive the key removal.
      if ('allowAds' in settings) expect(row.settings.allowAds).toBe(settings.allowAds);
    }
  );
});

// The fold is applied by hand AFTER deploy. A level the user sets in between must win over the
// stale red copy, so the writer drops that copy and the fold then leaves the user alone.
describe('a level set after deploy is not folded back', () => {
  const USER_ID = 100;

  beforeAll(() => {
    dbMock.dbWrite.$queryRawUnsafe.mockImplementation(
      (async (sql: string, ...params: unknown[]) => (await db.query(sql, params)).rows) as never
    );
    dbMock.dbWrite.user.update.mockImplementation((async ({
      where,
      data,
    }: {
      where: { id: number };
      data: { browsingLevel?: number };
    }) => {
      await db.query(`UPDATE "User" SET "browsingLevel" = $1 WHERE id = $2`, [
        data.browsingLevel,
        where.id,
      ]);
      return { id: where.id };
    }) as never);
  });

  it('keeps the new level and leaves no red copy for the fold to apply', async () => {
    // Narrowed on red before the deploy (stored only in the retired copy), then widened after it.
    await insert(USER_ID, 31, { redBrowsingLevel: 3 });
    await updateContentSettings({ userId: USER_ID, browsingLevel: 31 });

    const beforeFold = await read(USER_ID);
    expect('redBrowsingLevel' in beforeFold.settings).toBe(false);

    await applyMigration();

    const afterFold = await read(USER_ID);
    expect(afterFold.browsingLevel).toBe(31);
  });
});
