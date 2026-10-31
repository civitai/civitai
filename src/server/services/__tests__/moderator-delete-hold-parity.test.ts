import path from 'path';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerHeldSql } from '~/server/services/legal-hold.service';

/**
 * The moderator app cannot import the main app's hold SQL, so it keeps a copy. A drifted copy lets
 * a moderator delete what the purge jobs keep, or the reverse.
 */
describe("the moderator app's copy of ownerHeldSql", () => {
  let ownerHeldSqlText: (id: string) => string;

  beforeAll(async () => {
    const file = path.resolve(__dirname, '../../../..', 'apps/moderator/src/lib/server/delete-hold-sql.ts');
    ({ ownerHeldSqlText } = await import(/* @vite-ignore */ file));
    expect(typeof ownerHeldSqlText).toBe('function');
  });

  const squash = (sql: string) => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

  it.each(['"Image"."userId"', 'i."userId"'])('is the main app SQL over %s', (owner) => {
    const main = ownerHeldSql(Prisma.raw(owner));
    // A bound value would make the text alone an incomplete comparison.
    expect(main.values).toEqual([]);
    expect(squash(ownerHeldSqlText(owner))).toBe(squash(main.sql));
  });
});
