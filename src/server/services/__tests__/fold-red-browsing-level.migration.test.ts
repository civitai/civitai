import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Booting PGlite can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The committed, hand-applied data fix, executed as written: this pins what a human will run.
const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20260922220000_fold_red_browsing_level_into_column/migration.sql'
);

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
];

let db: PGlite;
let after: Map<number, Row>;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY,
      "browsingLevel" int NOT NULL DEFAULT 1,
      settings jsonb DEFAULT '{}'::jsonb
    );
  `);
  for (const [id, level, settings] of cases) {
    await db.query(
      `INSERT INTO "User" (id, "browsingLevel", settings) VALUES ($1, $2, $3::jsonb)`,
      [id, level, JSON.stringify(settings)]
    );
  }
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const rows = await db.query<Row>(`SELECT id, "browsingLevel", settings FROM "User" ORDER BY id`);
  after = new Map(rows.rows.map((r) => [r.id, r]));
});

afterAll(async () => {
  await db?.close();
});

describe('fold_red_browsing_level_into_column', () => {
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
