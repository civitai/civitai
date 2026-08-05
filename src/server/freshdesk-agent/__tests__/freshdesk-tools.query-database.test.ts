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
// exists only to record the text that check was handed. The tool rewrites the
// statement before executing it, and the scope check has to keep reading the
// model's ORIGINAL SQL — otherwise it audits our own wrapper. That the
// delegation is real is not asserted by inspection: the "refuses a relation
// outside the allowed set" case below only passes if the genuine check ran.
vi.mock('~/server/freshdesk-agent/freshdesk-query-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof QueryScopeModule>();
  h.checkQueryScope.mockImplementation(actual.checkQueryScope);
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

    // Invariant guard, not regression coverage: the scope check already read the
    // original SQL before this change. It is pinned here because the change
    // introduced a rewrite that a later edit could easily hoist above it.
    it('scope-checks the model\'s original SQL, never the rewritten statement', async () => {
      h.queryWithTimeout.mockResolvedValue({ rows: [] });

      await executeToolCall('query_database', { sql: ALLOWED_SQL });

      expect(h.checkQueryScope).toHaveBeenCalledTimes(1);
      expect(h.checkQueryScope).toHaveBeenCalledWith(ALLOWED_SQL);
      expect(h.checkQueryScope).not.toHaveBeenCalledWith(ALLOWED_SQL_BOUNDED);
      // ...and the rewrite still happened, so this is not passing because the
      // wrapping was skipped.
      expect(h.queryWithTimeout).toHaveBeenCalledWith(h.readPool, 30000, ALLOWED_SQL_BOUNDED);
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
