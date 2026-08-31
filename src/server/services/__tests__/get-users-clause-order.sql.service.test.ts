import { describe, it, expect, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `getUsers` builds one raw statement, and its `ORDER BY` used to sit on the same line as the
 * `u."id" != -1` predicate — with the `contestBanned` predicate added BELOW it. So a caller passing
 * both `query` and `contestBanned` emitted
 *
 *   ... AND u."id" != -1 ORDER BY LENGTH(username) ASC AND u."meta"->>'contestBanDetails' IS NOT NULL
 *
 * which Postgres rejects with 42601 before it runs anything. That is reachable rather than
 * theoretical: `user.getAll` routes to `getUsers` whenever a moderator sets `contestBanned`
 * (user.controller.ts), and `query` is on the same input schema.
 *
 * Nothing else can catch it. Both branches are optional, so the shape typechecks, and every existing
 * caller happens to pass one or the other — the statement is only wrong for the combination nobody
 * has sent yet. So this reads the emitted SQL and pins the ORDER of the clauses, not their presence.
 */

const statements: string[] = [];

// Nested `Prisma.sql` / `Prisma.raw` fragments carry the clauses this test is about, and a naive
// reduce over the template renders each one as a `$N` placeholder — so the assertions would be
// measuring the positions of placeholders rather than of SQL. Expand them.
const fragmentText = (value: unknown): string | null => {
  if (value && typeof value === 'object' && typeof (value as { sql?: unknown }).sql === 'string') {
    return (value as { sql: string }).sql;
  }
  return null;
};

const record = (first: unknown, rest: unknown[]) => {
  if (Array.isArray(first) && Array.isArray((first as unknown as TemplateStringsArray).raw)) {
    const chunks = first as string[];
    let text = chunks[0] ?? '';
    rest.forEach((value, i) => {
      text += fragmentText(value) ?? `${i + 1}`;
      text += chunks[i + 1] ?? '';
    });
    statements.push(text);
  } else if (fragmentText(first) !== null) {
    statements.push(fragmentText(first) as string);
  } else {
    statements.push(String(first));
  }
  return [] as unknown[];
};

dbMock.dbRead.$queryRaw.mockImplementation(async (first: unknown, ...rest: unknown[]) =>
  record(first, rest)
);

const { getUsers } = await import('~/server/services/user.service');

const sqlFor = async (input: Parameters<typeof getUsers>[0]) => {
  statements.length = 0;
  await getUsers(input);
  return statements[0] ?? '';
};

describe('getUsers clause order', () => {
  beforeEach(() => {
    statements.length = 0;
  });

  it('puts ORDER BY after every predicate when both query and contestBanned are set', async () => {
    const sql = await sqlFor({ query: 'spam', contestBanned: true, limit: 20 });

    const orderBy = sql.indexOf('ORDER BY');
    const contestPredicate = sql.indexOf('contestBanDetails');
    expect(orderBy).toBeGreaterThan(-1);
    expect(contestPredicate).toBeGreaterThan(-1);
    // The whole bug in one assertion: a predicate after ORDER BY is 42601, not a mis-sort.
    expect(orderBy).toBeGreaterThan(contestPredicate);
  });

  it('keeps LIMIT last', async () => {
    // ORDER BY moved; LIMIT must not have moved above it, which would be the same class of error.
    const sql = await sqlFor({ query: 'spam', contestBanned: true, limit: 20 });

    expect(sql.indexOf('LIMIT')).toBeGreaterThan(sql.indexOf('ORDER BY'));
  });

  it('emits no ORDER BY without a query, which is what every contest-ban caller does today', async () => {
    // The negative control. If this ever starts emitting one, the first test stops proving anything
    // about ordering because the clause it measures would be present either way.
    const sql = await sqlFor({ contestBanned: true, limit: 20 });

    expect(sql).not.toContain('ORDER BY');
    expect(sql).toContain('contestBanDetails');
  });
});
