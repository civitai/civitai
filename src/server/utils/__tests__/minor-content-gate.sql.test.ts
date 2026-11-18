import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '@civitai/shared';
import { isMinorContentRestricted } from '@civitai/shared/minor-content-gate';
import { minorContentRestrictedSql } from '~/server/utils/minor-content-gate.sql';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { PG, PG13, R, X, XXX, Blocked } = NsfwLevel;
const LEVELS = [null, 0, PG, PG13, PG | PG13, R, X, XXX, Blocked, PG | R];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE t (minor boolean NOT NULL, "nsfwLevel" int)`);
  for (const minor of [true, false])
    for (const level of LEVELS)
      await db.query(`INSERT INTO t (minor, "nsfwLevel") VALUES ($1, $2)`, [minor, level]);
});
afterAll(() => db?.close());

describe('the SQL minor content rule', () => {
  it('restricts exactly the rows the TypeScript rule restricts', async () => {
    const query = Prisma.sql`SELECT minor, "nsfwLevel", ${minorContentRestrictedSql({
      minor: Prisma.sql`minor`,
      nsfwLevel: Prisma.sql`"nsfwLevel"`,
    })} AS restricted FROM t`;
    const { rows } = await db.query<{
      minor: boolean;
      nsfwLevel: number | null;
      restricted: boolean;
    }>(query.text, query.values);

    expect(rows).toHaveLength(LEVELS.length * 2);
    for (const row of rows)
      expect(row.restricted, `minor=${row.minor} level=${row.nsfwLevel}`).toBe(
        isMinorContentRestricted(row)
      );
    // Both outcomes occur, so a rule stuck at one answer cannot pass.
    expect(new Set(rows.map((row) => row.restricted))).toEqual(new Set([true, false]));
  });
});
