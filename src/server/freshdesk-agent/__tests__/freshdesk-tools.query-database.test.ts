import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpersModule from '~/server/db/db-helpers';
import type * as PgDbModule from '~/server/db/pgDb';
import type * as DbClientModule from '~/server/db/client';

/**
 * `query_database` runs SQL the model wrote, so the tool carries the bounds:
 * it must go through `queryWithTimeout` (BEGIN READ ONLY + a server-side
 * `SET LOCAL statement_timeout`) rather than straight at the app-wide read
 * client, and it must refuse a relation it is not scoped to before it takes a
 * connection at all.
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

// These two build a singleton at module load and throw without their env vars,
// so `importOriginal` cannot be used on them. Each has exactly one export, and
// no test here reaches either.
vi.mock('~/server/http/freshdesk/freshdesk.caller', () => ({ freshdeskCaller: {} }));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: {} }));

import { executeToolCall } from '~/server/freshdesk-agent/freshdesk-tools';

const ALLOWED_SQL = 'SELECT id, username FROM "User" WHERE id = 7 LIMIT 1';

describe('query_database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs an allowed query through the read-only / statement-timeout helper', async () => {
    h.queryWithTimeout.mockResolvedValue({ rows: [{ id: 7, username: 'ada' }] });

    const result = await executeToolCall('query_database', { sql: ALLOWED_SQL });

    expect(h.queryWithTimeout).toHaveBeenCalledTimes(1);
    expect(h.queryWithTimeout).toHaveBeenCalledWith(h.readPool, 30000, ALLOWED_SQL);
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
    expect(call[2]).toBe(ALLOWED_SQL);
    expect(call[2]).not.toBe('SELECT id, username FROM "Session" WHERE id = 7 LIMIT 1');
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
