import path from 'path';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { detachHeldThreadsSql } from '~/server/services/comment-thread-hold';
import { heldCommentV3OnArticleSql } from '~/server/services/commentv3/moderation.service';
import { accountHoldSql, ownerHeldSql } from '~/server/services/legal-hold.service';

/**
 * The moderator app cannot import the main app's hold SQL, so it keeps a copy. A drifted copy lets
 * a moderator delete what the purge jobs keep, or the reverse.
 */
describe("the moderator app's copy of ownerHeldSql", () => {
  let ownerHeldSqlText: (id: string) => string;

  beforeAll(async () => {
    const file = path.resolve(
      __dirname,
      '../../../..',
      'apps/moderator/src/lib/server/delete-hold-sql.ts'
    );
    ({ ownerHeldSqlText } = await import(/* @vite-ignore */ file));
    expect(typeof ownerHeldSqlText).toBe('function');
  });

  const squash = (sql: string) =>
    sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

  it.each(['"Image"."userId"', 'i."userId"'])('is the main app SQL over %s', (owner) => {
    const main = ownerHeldSql(Prisma.raw(owner));
    // A bound value would make the text alone an incomplete comparison.
    expect(main.values).toEqual([]);
    expect(squash(ownerHeldSqlText(owner))).toBe(squash(main.sql));
  });
});

/** The article delete's comment holds, which the moderator app's article delete applies too. */
describe("the moderator app's copies of the article delete's comment holds", () => {
  type Copies = {
    accountHoldSqlText: (id: string) => string;
    detachHeldArticleThreadsSqlText: (articleIds: string) => string;
    heldCommentV3OnArticleSqlText: (articleId: string) => string;
  };
  let copies: Copies;

  beforeAll(async () => {
    const file = path.resolve(
      __dirname,
      '../../../..',
      'apps/moderator/src/lib/server/delete-hold-sql.ts'
    );
    copies = await import(/* @vite-ignore */ file);
  });

  const squash = (sql: string) =>
    sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  // The main app binds a few literals; the copy writes them inline.
  const inlined = (sql: Prisma.Sql) => {
    let i = 0;
    return sql.sql.replace(/\?/g, () => {
      const value = sql.values[i++];
      if (typeof value !== 'string') throw new Error(`unexpected bound value ${String(value)}`);
      return `'${value.replace(/'/g, "''")}'`;
    });
  };

  it('accountHoldSql, with the marker view present', () => {
    const main = accountHoldSql(Prisma.raw('a."userId"'), true);
    expect(main.values).toEqual([]);
    expect(squash(copies.accountHoldSqlText('a."userId"'))).toBe(squash(main.sql));
  });

  it('detachHeldThreadsSql for articles', () => {
    const main = detachHeldThreadsSql({ articleId: Prisma.raw('SELECT 70::int') }, true);
    expect(squash(copies.detachHeldArticleThreadsSqlText('SELECT 70::int'))).toBe(
      squash(inlined(main))
    );
  });

  it('heldCommentV3OnArticleSql', () => {
    const main = heldCommentV3OnArticleSql(Prisma.raw('70::int'), true);
    expect(main.values).toEqual([]);
    expect(squash(copies.heldCommentV3OnArticleSqlText('70::int'))).toBe(squash(main.sql));
  });
});
