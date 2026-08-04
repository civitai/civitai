import { describe, expect, it } from 'vitest';
import {
  FRESHDESK_QUERY_TABLES,
  checkQueryScope,
} from '~/server/freshdesk-agent/freshdesk-query-scope';

/**
 * `checkQueryScope` bounds which relations the model-authored `query_database`
 * statement may read. Two properties matter and both are pinned below:
 *   - an allowed table is confirmed and passes, and
 *   - anything the check cannot positively confirm is refused, including the
 *     shapes it is not built to read (CTEs, schema prefixes, table functions,
 *     FROM-as-function-call). A refusal it did not intend is a false rejection
 *     with a documented rewrite; a pass it did not intend is a hole.
 *
 * Expectations are literal. The allowed-table list in particular is written out
 * by hand rather than derived from the export, so widening the export cannot
 * quietly widen the test.
 */
describe('checkQueryScope — the allowed table list', () => {
  it('is exactly the relations the agent already reads', () => {
    expect([...FRESHDESK_QUERY_TABLES]).toEqual([
      'BuzzWithdrawalRequest',
      'Challenge',
      'ChallengeWinner',
      'Changelog',
      'Cosmetic',
      'CryptoDeposit',
      'CryptoWallet',
      'CustomerSubscription',
      'Image',
      'ImageReport',
      'Model',
      'ModelReport',
      'Post',
      'PostReport',
      'Price',
      'Product',
      'Purchase',
      'Report',
      'User',
      'UserCosmetic',
      'UserCosmeticShopPurchases',
      'UserProfile',
      'UserReport',
      'UserRestriction',
      'UserStat',
      'UserStrike',
    ]);
  });
});

describe('checkQueryScope — statements it confirms', () => {
  it.each([
    ['a plain single-table read', 'SELECT id, username, email FROM "User" WHERE id = 7 LIMIT 1'],
    [
      'an explicit join',
      'SELECT c.name FROM "UserCosmetic" uc JOIN "Cosmetic" c ON c.id = uc."cosmeticId" LIMIT 5',
    ],
    ['a comma join', 'SELECT * FROM "User" u, "Model" m WHERE m."userId" = u.id LIMIT 5'],
    [
      'a comma join after an ON clause',
      'SELECT * FROM "User" u JOIN "Model" m ON m."userId" = u.id, "Post" p LIMIT 5',
    ],
    ['a sub-select in the FROM list', 'SELECT * FROM (SELECT id FROM "User" LIMIT 5) x'],
    [
      'a parenthesized join of allowed tables',
      'SELECT * FROM ("User" JOIN "Model" ON true) LIMIT 5',
    ],
    ['an inline VALUES list in the FROM list', 'SELECT x FROM (VALUES (1), (2)) AS t(x)'],
    [
      'an inline VALUES list joined to an allowed table',
      'SELECT * FROM (VALUES (1)) AS t(x) JOIN "User" u ON u.id = t.x',
    ],
    [
      'a sub-select in the FROM list followed by another relation',
      'SELECT * FROM (SELECT id FROM "User" LIMIT 5) x, "Model" m',
    ],
    [
      'a sub-select in the target list',
      'SELECT (SELECT count(*) FROM "Image" WHERE "userId" = u.id) FROM "User" u LIMIT 1',
    ],
    [
      'a sub-select in an IN predicate',
      'SELECT id FROM "Post" WHERE "userId" IN (SELECT id FROM "User")',
    ],
    ['both branches of a UNION', 'SELECT id FROM "Model" UNION SELECT id FROM "Image"'],
    ['a trailing semicolon', 'SELECT id FROM "User" LIMIT 1;'],
    ['no FROM clause at all', 'SELECT 1'],
    ['a string literal containing SQL-looking text', `SELECT id FROM "User" WHERE email = 'a@b.c'`],
    [
      'a string literal containing a doubled quote',
      `SELECT id FROM "User" WHERE username = 'O''Brien'`,
    ],
  ])('allows %s', (_label, sql) => {
    expect(checkQueryScope(sql)).toEqual({ ok: true });
  });
});

describe('checkQueryScope — relations outside the allowed set', () => {
  it('refuses a table that is not on the list, and names it', () => {
    const result = checkQueryScope('SELECT "key" FROM "KeyValue" LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(
      /^Error: query_database cannot read "KeyValue"\. It is limited to these tables: /
    );
    expect(result.error).toContain('"User"');
    expect(result.error).toContain('"UserStrike"');
  });

  it('refuses a disallowed table reached through a join', () => {
    const result = checkQueryScope(
      'SELECT * FROM "User" u JOIN "Session" s ON s."userId" = u.id LIMIT 1'
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Session"');
  });

  it('refuses a disallowed table reached through a comma join', () => {
    const result = checkQueryScope('SELECT * FROM "User" u, "Account" a LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Account"');
  });

  it('refuses a disallowed table reached through a comma after an ON clause', () => {
    const result = checkQueryScope(
      'SELECT * FROM "User" u JOIN "Model" m ON m."userId" = u.id, "ApiKey" k LIMIT 1'
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "ApiKey"');
  });

  it('refuses a disallowed table inside a nested sub-select', () => {
    const result = checkQueryScope(
      'SELECT * FROM "User" WHERE id IN (SELECT "userId" FROM (SELECT "userId" FROM "Session") s)'
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Session"');
  });

  /**
   * A parenthesized join expression is a relation position, not a sub-select:
   * `FROM ("A" JOIN "B" ON ...)` is valid Postgres and its FIRST item is a
   * relation. Every other `FROM (` case in this file is a sub-select, so these
   * pin the other reading of the same two characters — the leading relation
   * must still be checked, at any depth and for every join flavour.
   */
  it('refuses a disallowed table leading a parenthesized join', () => {
    const result = checkQueryScope('SELECT * FROM ("Session" JOIN "User" ON true) LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Session"');
  });

  it('refuses a disallowed table leading a parenthesized CROSS JOIN', () => {
    const result = checkQueryScope('SELECT * FROM ("ApiKey" CROSS JOIN "User") LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "ApiKey"');
  });

  it('refuses a disallowed table leading a doubly-parenthesized join', () => {
    const result = checkQueryScope('SELECT * FROM (("Account" JOIN "User" ON true)) LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Account"');
  });

  it('still refuses a disallowed table in the trailing position of a parenthesized join', () => {
    const result = checkQueryScope('SELECT * FROM ("User" JOIN "Session" ON true) LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Session"');
  });

  it('refuses a disallowed table reached from inside an inline VALUES list', () => {
    const result = checkQueryScope('SELECT * FROM (VALUES ((SELECT id FROM "Session"))) AS t(x)');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Session"');
  });

  it('refuses a disallowed table in the second branch of a UNION', () => {
    const result = checkQueryScope('SELECT id FROM "User" UNION SELECT id FROM "Session"');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "Session"');
  });

  it('is case sensitive — the folded spelling is a different relation', () => {
    const result = checkQueryScope('SELECT id FROM "user" LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "user"');
  });
});

describe('checkQueryScope — shapes it cannot read, and therefore refuses', () => {
  it('refuses a bare (unquoted) relation name', () => {
    const result = checkQueryScope('SELECT id FROM users LIMIT 1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(
      /^Error: query_database expected a double-quoted table name after FROM\/JOIN and got users\./
    );
  });

  it('refuses a schema-qualified name', () => {
    expect(checkQueryScope('SELECT id FROM "public"."User" LIMIT 1').ok).toBe(false);
  });

  it('refuses the catalog', () => {
    expect(checkQueryScope('SELECT * FROM pg_stat_activity LIMIT 1').ok).toBe(false);
    expect(checkQueryScope('SELECT * FROM information_schema.tables LIMIT 1').ok).toBe(false);
  });

  it('refuses a bare pg_* identifier even with no FROM clause', () => {
    const result = checkQueryScope('SELECT pg_sleep(60)');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/^Error: query_database reads application tables only\./);
  });

  it('refuses a nested CTE, whose name is not a real relation', () => {
    expect(
      checkQueryScope('SELECT * FROM (WITH t AS (SELECT 1 AS id) SELECT id FROM t) x').ok
    ).toBe(false);
  });

  it('refuses a table function in relation position', () => {
    expect(checkQueryScope('SELECT * FROM generate_series(1, 10)').ok).toBe(false);
  });

  it('refuses FROM used as function-call syntax (a documented false rejection)', () => {
    // `EXTRACT(EPOCH FROM col)` reads as a relation position. The rewrite is
    // `date_part('epoch', col)`, which the tool description tells the model.
    const result = checkQueryScope('SELECT EXTRACT(EPOCH FROM "createdAt") FROM "User"');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('cannot read "createdAt"');
    expect(checkQueryScope(`SELECT date_part('epoch', "createdAt") FROM "User"`)).toEqual({
      ok: true,
    });
  });

  it('refuses comments rather than stripping them', () => {
    expect(checkQueryScope('SELECT id FROM "User" -- WHERE id = 1')).toEqual({
      ok: false,
      error: 'Error: SQL comments are not supported by query_database. Remove them.',
    });
    expect(checkQueryScope('SELECT id /* note */ FROM "User"')).toEqual({
      ok: false,
      error: 'Error: SQL comments are not supported by query_database. Remove them.',
    });
  });

  it('refuses a second statement after a semicolon', () => {
    expect(checkQueryScope('SELECT 1; SELECT id FROM "Session"')).toEqual({
      ok: false,
      error: 'Error: query_database runs exactly one statement. Remove the extra ";".',
    });
  });

  it('refuses dollar quoting and bind-parameter syntax', () => {
    expect(checkQueryScope('SELECT $$x$$ FROM "User"')).toEqual({
      ok: false,
      error:
        'Error: $ (dollar quoting / bind parameters) is not supported by query_database. Inline plain literals.',
    });
    expect(checkQueryScope('SELECT id FROM "User" WHERE username = $1').ok).toBe(false);
  });

  it('refuses backslashes', () => {
    expect(checkQueryScope('SELECT 1 \\ FROM "User"')).toEqual({
      ok: false,
      error: 'Error: backslashes are not supported by query_database.',
    });
  });

  it('refuses an unterminated string literal', () => {
    expect(checkQueryScope(`SELECT id FROM "User" WHERE username = 'a`)).toEqual({
      ok: false,
      error: 'Error: unterminated string literal in query.',
    });
  });

  it('refuses prefixed literal forms whose quoting rules differ', () => {
    expect(checkQueryScope(`SELECT id FROM "User" WHERE username = E'a\\'' AND id = 1`).ok).toBe(
      false
    );
  });

  it('refuses a statement that ends where a table name was expected', () => {
    expect(checkQueryScope('SELECT id FROM')).toEqual({
      ok: false,
      error: 'Error: query is incomplete — a table name was expected after FROM/JOIN.',
    });
  });

  it('refuses a write verb even when the statement opens with SELECT', () => {
    const result = checkQueryScope('SELECT id INTO "Report" FROM "User"');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe(
      'Error: query_database runs read-only SELECT statements. "INTO" is not available.'
    );
  });
});
