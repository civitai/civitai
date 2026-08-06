import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpersModule from '~/server/db/db-helpers';
import type * as PgDbModule from '~/server/db/pgDb';
import type * as DbClientModule from '~/server/db/client';
import type * as QueryScopeModule from '~/server/freshdesk-agent/freshdesk-query-scope';

/**
 * `query_database` runs SQL the model wrote, so the tool carries the bounds:
 * it must go through `queryWithTimeout` (BEGIN READ ONLY + a server-side
 * `SET LOCAL statement_timeout`) rather than straight at the app-wide read
 * client, it must refuse a relation it is not scoped to before it takes a
 * connection at all, and it must bound the ROW COUNT in the statement it hands
 * the driver — node-postgres buffers a whole result set into the heap, so a
 * bound applied to the returned array is not a bound on this process.
 *
 * These tests drive the exported `executeToolCall` — the same entry point the
 * agent loop calls — so they exercise the real dispatch, not a shortcut.
 */

const h = vi.hoisted(() => ({
  // A sentinel rather than a real Pool: the assertion is "the bounded helper
  // was handed the READ pool", and identity makes that unambiguous.
  readPool: { __testDouble: 'pgDbRead' },
  queryWithTimeout: vi.fn(),
  prismaQueryRaw: vi.fn(),
  checkQueryScope: vi.fn(),
  // Captured from the mock factory so `beforeEach` can rebuild the pass-through
  // after draining the spy. Typed loosely because it is assigned inside the
  // hoisted factory, before the module type is in scope.
  actualCheckQueryScope: undefined as undefined | ((sql: string) => unknown),
}));

// Narrow overrides that keep every other export real. A hand-written
// replacement object would pin these modules' export surface to today's shape
// and silently collect zero tests the day one of them grows an export.
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpersModule>()),
  queryWithTimeout: h.queryWithTimeout,
}));

vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<typeof PgDbModule>()),
  pgDbRead: h.readPool,
}));

// The app-wide Prisma read client. Stubbed so that "the tool never touches it"
// is an assertion this file can make rather than an inference.
vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof DbClientModule>()),
  dbRead: { $queryRaw: h.prismaQueryRaw },
}));

// A pass-through spy, NOT a stub: it delegates to the real scope check and
// exists only to record WHICH text each call was handed — the tool validates
// the model's original and the rewritten statement, and those are different
// strings. That the delegation is real is not asserted by inspection: the
// "refuses a relation outside the allowed set" case below only passes if the
// genuine check ran.
vi.mock('~/server/freshdesk-agent/freshdesk-query-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof QueryScopeModule>();
  h.actualCheckQueryScope = actual.checkQueryScope as (sql: string) => unknown;
  return { ...actual, checkQueryScope: h.checkQueryScope };
});

// These two build a singleton at module load and throw without their env vars,
// so `importOriginal` cannot be used on them. Each has exactly one export, and
// no test here reaches either.
vi.mock('~/server/http/freshdesk/freshdesk.caller', () => ({ freshdeskCaller: {} }));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: {} }));

import { executeToolCall } from '~/server/freshdesk-agent/freshdesk-tools';

const ALLOWED_SQL = 'SELECT id, username FROM "User" WHERE id = 7 LIMIT 1';

/**
 * The exact statement the driver must receive for `ALLOWED_SQL`. Typed out by
 * hand rather than assembled from the implementation's alias/limit constants:
 * derived from the implementation it would agree with any rewrite, including
 * one that dropped the outer LIMIT entirely.
 */
const ALLOWED_SQL_BOUNDED =
  'SELECT * FROM (SELECT id, username FROM "User" WHERE id = 7 LIMIT 1) __civitai_row_bound LIMIT 51';

/** Build N distinct rows — distinct so a slice boundary is readable off the values. */
const rowsOfLength = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, username: `u${i + 1}` }));

describe('query_database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` resets recorded calls but does NOT drain a
    // `mockReturnValueOnce` queue. One test below queues two once-values to
    // reach an internal guard; if a change makes the code consume only one of
    // them, the leftover leaks into the NEXT test and attributes a failure to
    // the wrong cause — observed while mutation-testing this file. `mockReset`
    // empties the queue, so the pass-through has to be reinstalled here rather
    // than only in the mock factory.
    h.checkQueryScope.mockReset();
    h.checkQueryScope.mockImplementation(h.actualCheckQueryScope!);
  });

  it('runs an allowed query through the read-only / statement-timeout helper', async () => {
    h.queryWithTimeout.mockResolvedValue({ rows: [{ id: 7, username: 'ada' }] });

    const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

    expect(h.queryWithTimeout).toHaveBeenCalledTimes(1);
    expect(h.queryWithTimeout).toHaveBeenCalledWith(h.readPool, 30000, ALLOWED_SQL_BOUNDED);
    expect(h.prismaQueryRaw).not.toHaveBeenCalled();
    expect(result).toBe(JSON.stringify([{ id: 7, username: 'ada' }], null, 2));
  });

  it('harness check: the double records the real call, not a tagged-template call', async () => {
    // A tagged template handed to a vi.fn arrives as (TemplateStringsArray,
    // ...values) — the SQL would show up as an array of fragments and an
    // arity-3 (pool, ms, string) assertion would be vacuously unreachable. Pin
    // the shape here so the assertions above cannot pass on a mis-capture,
    // and pin a value the call did NOT make so the matcher is shown to
    // discriminate.
    h.queryWithTimeout.mockResolvedValue({ rows: [] });

    await executeToolCall('query_database', { sql: ALLOWED_SQL });

    const call = h.queryWithTimeout.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(Array.isArray(call[2])).toBe(false);
    expect(typeof call[2]).toBe('string');
    expect(call[2]).toBe(ALLOWED_SQL_BOUNDED);
    expect(call[2]).not.toBe('SELECT id, username FROM "Session" WHERE id = 7 LIMIT 1');
  });

  describe('row bound', () => {
    it('bounds the row count in the SQL it hands the driver, not after the fact', async () => {
      // The load-bearing assertion of this file: an outer LIMIT in the text the
      // database receives. A test that only checked `result` had at most 50
      // rows would pass with the bug fully present, because the bug is that the
      // whole result set reaches the heap first.
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', { sql: 'SELECT * FROM "User"' });

      expect(h.queryWithTimeout).toHaveBeenCalledWith(
        h.readPool,
        30000,
        'SELECT * FROM (SELECT * FROM "User") __civitai_row_bound LIMIT 51'
      );
    });

    it('strips the trailing semicolon before wrapping', async () => {
      // `checkQueryScope` accepts one trailing `;`, and `SELECT * FROM (SELECT
      // 1;) x LIMIT 51` is a Postgres syntax error — verified against Postgres
      // 18, which reports `syntax error at or near ";"`.
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', { sql: 'SELECT id FROM "User" LIMIT 1;  ' });

      expect(h.queryWithTimeout).toHaveBeenCalledWith(
        h.readPool,
        30000,
        'SELECT * FROM (SELECT id FROM "User" LIMIT 1) __civitai_row_bound LIMIT 51'
      );
    });

    it('wraps a UNION as a whole rather than binding only its last branch', async () => {
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', {
        sql: 'SELECT id FROM "User" UNION SELECT id FROM "Model"',
      });

      expect(h.queryWithTimeout).toHaveBeenCalledWith(
        h.readPool,
        30000,
        'SELECT * FROM (SELECT id FROM "User" UNION SELECT id FROM "Model") __civitai_row_bound LIMIT 51'
      );
    });

    it('keeps a top-level ORDER BY inside the wrap', async () => {
      // Ordering must be applied before the bound, or "the 50 newest" silently
      // becomes "50 arbitrary rows, then sorted". Verified against Postgres 18:
      // the plan is `Limit -> Sort`, and the wrap returns the same top rows the
      // unwrapped statement does.
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', {
        sql: 'SELECT id FROM "User" ORDER BY "createdAt" DESC',
      });

      expect(h.queryWithTimeout).toHaveBeenCalledWith(
        h.readPool,
        30000,
        'SELECT * FROM (SELECT id FROM "User" ORDER BY "createdAt" DESC) __civitai_row_bound LIMIT 51'
      );
    });

    it('reports truncation when the extra probe row comes back', async () => {
      h.queryWithTimeout.mockResolvedValue({ rows: rowsOfLength(51) });

      const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

      const [json, note] = result.split('\n\n');
      expect(JSON.parse(json)).toHaveLength(50);
      expect(JSON.parse(json)[49]).toEqual({ id: 50, username: 'u50' });
      expect(note).toBe(
        'Truncated: more than 50 rows matched and only the first 50 are shown. Narrow the query — add a WHERE filter, an ORDER BY, or a smaller LIMIT.'
      );
    });

    it('does not claim truncation on a full page that was not truncated', async () => {
      // The boundary the 51st row exists to resolve: 50 rows back means 50 rows
      // matched. Reporting truncation here would send the model narrowing a
      // query that was already complete.
      h.queryWithTimeout.mockResolvedValue({ rows: rowsOfLength(50) });

      const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

      expect(result).not.toContain('Truncated');
      expect(JSON.parse(result)).toHaveLength(50);
    });

    // The rewrite means the string that is VALIDATED and the string that is
    // EXECUTED are not the same object. Both must go through the scope check,
    // in that order: the original owns the model-facing error message, the
    // executed one is what actually has to be proven in scope.
    it('scope-checks the original AND the statement it actually executes', async () => {
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', { sql: ALLOWED_SQL });

      expect(h.checkQueryScope).toHaveBeenCalledTimes(2);
      expect(h.checkQueryScope.mock.calls[0][0]).toBe(ALLOWED_SQL);
      expect(h.checkQueryScope.mock.calls[1][0]).toBe(ALLOWED_SQL_BOUNDED);
      // The string handed to the driver is byte-identical to the one the second
      // check cleared — otherwise the check is of a string nobody runs.
      expect(h.queryWithTimeout).toHaveBeenCalledWith(h.readPool, 30000, ALLOWED_SQL_BOUNDED);
    });

    it('refuses to execute if the rewritten statement fails the scope check', async () => {
      // Reachability: with the paren-balance fix no real input gets here, so the
      // branch is driven directly. Without this the guard would be dead code
      // that no mutation could kill.
      h.checkQueryScope
        .mockReturnValueOnce({ ok: true })
        .mockReturnValueOnce({ ok: false, error: 'Error: synthetic rewrite failure' });

      const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

      expect(h.queryWithTimeout).not.toHaveBeenCalled();
      expect(result).toBe(
        'Error: query_database could not verify this statement stays within its allowed tables. Rewrite it as a simple SELECT over the allowed tables.'
      );
      // The internal failure is not described to the model.
      expect(result).not.toContain('synthetic');
    });
  });

  /**
   * The seam the row-bound wrap created: `checkQueryScope` reasons about the
   * model's text, the driver runs the WRAPPED text, and a wrapper supplies
   * parentheses. Text that is a syntax error standing alone can therefore be a
   * valid statement once wrapped — reaching a relation the scope walk never
   * audited, because a stray ")" desynchronised its depth bookkeeping.
   *
   * Every other fixture in this file is well-formed balanced SQL. That is
   * exactly why a 5-mutant sweep and 35 Postgres probes did not find this: the
   * bug lives in text none of them contained.
   */
  describe('paren-unbalanced input never reaches the driver', () => {
    const EVASION = 'SELECT 1) x, "Session" s WHERE s.id = 1 UNION SELECT 0, 0, 0 FROM (SELECT 1';

    it('refuses a statement that would only become valid once wrapped', async () => {
      const result = await executeToolCall('query_database', { sql: EVASION });

      // The load-bearing assertion: nothing was executed. Asserting only on the
      // returned string would pass even if the query had run and returned rows.
      expect(h.queryWithTimeout).not.toHaveBeenCalled();
      expect(h.prismaQueryRaw).not.toHaveBeenCalled();
      expect(result).toContain('unbalanced parentheses');
    });

    it('never hands the driver a statement naming an out-of-scope relation', async () => {
      // Independent of WHY it was refused: whatever this tool executes must not
      // mention a relation outside the allowlist. Stated over the whole call
      // record rather than one argument, so a second execution path added later
      // is covered too.
      for (const sql of [
        EVASION,
        'SELECT 1) x, "Account" a',
        'SELECT * FROM (SELECT id FROM "User")) x, "ApiKey" k',
      ]) {
        await executeToolCall('query_database', { sql });
      }

      const executed = JSON.stringify(h.queryWithTimeout.mock.calls);
      expect(h.queryWithTimeout).not.toHaveBeenCalled();
      for (const forbidden of ['Session', 'Account', 'ApiKey']) {
        expect(executed).not.toContain(forbidden);
      }
    });

    it('positive control: the same assertion CAN see a relation name', async () => {
      // Proves the previous test's `not.toContain` is capable of failing. A
      // never-called mock makes any `not.toContain` over its calls vacuously
      // true, so the matcher has to be shown observing a real relation name.
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', { sql: 'SELECT id FROM "User" LIMIT 1' });

      const executed = JSON.stringify(h.queryWithTimeout.mock.calls);
      expect(h.queryWithTimeout).toHaveBeenCalledTimes(1);
      expect(executed).toContain('User');
    });
  });

  it('refuses a relation outside the allowed set without taking a connection', async () => {
    const result = await executeToolCall('query_database', {
      sql: 'SELECT "key" FROM "KeyValue" LIMIT 1',
    });

    expect(h.queryWithTimeout).not.toHaveBeenCalled();
    expect(h.prismaQueryRaw).not.toHaveBeenCalled();
    expect(result).toMatch(
      /^Error: query_database cannot read "KeyValue"\. It is limited to these tables: /
    );
  });

  // Invariant guard, not regression coverage: this check predates the change
  // and is here so a later edit cannot drop it.
  it('refuses a non-SELECT statement', async () => {
    const result = await executeToolCall('query_database', {
      sql: 'UPDATE "User" SET "muted" = true WHERE id = 7',
    });

    expect(result).toBe('Error: Only SELECT queries are allowed.');
    expect(h.queryWithTimeout).not.toHaveBeenCalled();
    expect(h.prismaQueryRaw).not.toHaveBeenCalled();
  });

  it('reports a database-side cancellation in terms the model can act on', async () => {
    h.queryWithTimeout.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    );

    const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

    expect(result).toBe(
      'Query error: cancelled after 30s. Narrow the query — add a LIMIT and filter on indexed columns.'
    );
  });

  it('passes other database errors through', async () => {
    h.queryWithTimeout.mockRejectedValue(new Error('relation "User" does not exist'));

    const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

    expect(result).toBe('Query error: relation "User" does not exist');
  });

  it('returns a plain message for an empty result set', async () => {
    h.queryWithTimeout.mockResolvedValue({ rows: [] });

    const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

    expect(result).toBe('No results found.');
  });
});
