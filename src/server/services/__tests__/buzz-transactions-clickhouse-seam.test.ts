import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SEAM between `getUserBuzzTransactionsMulti` and the two ClickHouse type
 * conversions it depends on.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * 🔴 `clickhouse-transaction-type.test.ts` next door tests the two helpers
 * hermetically, and a round-2 audit showed that is not enough: reverting BOTH
 * production call sites to the open-coded expression the helpers replaced left
 * that suite — and the whole 134-test set around it — completely GREEN. The
 * helpers were covered; nothing asserted production used them. That is the
 * defect the consolidation claims to fix, so the claim had no guard at all.
 *
 * So these tests drive the REAL exported function and assert two things about
 * what it emits and returns, not about the helpers:
 *
 *   - the SQL it sends carries the numeric spelling of the type filter, because
 *     a name-only predicate silently matches nothing for a member past the
 *     ingest map's `0..26` ceiling
 *   - a row whose `type` column holds `'28'` comes back as the NUMBER 28, not
 *     the string `'AppAuthorFee'` that the enum's reverse mapping yields
 *
 * 🔴 BOTH READ PATHS, and they are two independent expressions. The list
 * (`hydrateTransactions`) and the CSV export (`formatExportBatch`) each resolve
 * `row.type` on their own line; only the list one was covered when this file was
 * first written, so reverting the export site alone survived the whole suite. The
 * CSV column reading `28` is the symptom a user cannot work around, so it gets its
 * own tests rather than riding on the shared filter.
 *
 * ── WHAT IS MOCKED ──────────────────────────────────────────────────────────
 * The three this file mocks itself, on top of the project-wide mocks in
 * `src/__tests__/setup.ts` (db, redis, env, prom, logging and others — so "only
 * the edges" is true of this file, not of the process): the ClickHouse client
 * (the seam under test — the mock is how the SQL is captured and the row shape
 * injected), `getUsers`, and the logger. `buildBranchQuery`,
 * `walkTransactionSlices`, `hydrateTransactions` and `formatExportBatch` all run
 * for real, which is the point.
 */

// Top-level `import type * as`, not an inline `typeof import(...)` — the latter
// trips `consistent-type-imports`, which is an eslint ERROR in this repo.
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as UserService from '~/server/services/user.service';

const { mockQuery, mockGetUsers } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetUsers: vi.fn(),
}));

// Spread the real module and override only the client, matching the sibling suite in
// this directory. That module re-exports the whole package surface plus the app
// Tracker, so a hand-listed mock couples this file to all of it and dies at
// COLLECTION — naming an unrelated file as the cause — the first time buzz.service's
// graph needs a second export from it.
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: (sql: string) => mockQuery(sql) },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUsers: (...args: unknown[]) => mockGetUsers(...args),
}));

import {
  getUserBuzzTransactionsMulti,
  streamUserBuzzTransactionsCsv,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
loggingMock.logToAxiom.mockResolvedValue(null);

const ACCOUNT_ID = 4242;

/** A row as ClickHouse hands it over: every column a string or a number. */
function row(over: Record<string, unknown> = {}) {
  return {
    transactionId: '00000000-0000-0000-0000-000000000001',
    date: '2026-09-26 16:51:00',
    type: 'tip',
    amount: 11,
    fromAccountId: 77,
    toAccountId: ACCOUNT_ID,
    fromAccountType: 'user',
    toAccountType: 'user',
    description: null,
    details: null,
    externalTransactionId: null,
    ...over,
  };
}

/** A narrow window, so the slice walker issues few queries. */
const WINDOW = {
  start: new Date('2026-09-20T00:00:00Z'),
  end: new Date('2026-09-26T23:59:59Z'),
  // Required by the schema and by `buildBranchQuery`, which maps over it.
  accountTypes: ['yellow'] as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockGetUsers.mockReset();
  mockGetUsers.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
});

/** Every SQL string the service actually sent. */
function sentSql() {
  return mockQuery.mock.calls.map((c) => c[0] as string);
}

describe('getUserBuzzTransactionsMulti — the ClickHouse type seam', () => {
  /**
   * 🔴 THE WIRING GUARD FOR THE PREDICATE. Reverting `buildBranchQuery` to
   * `type = '<name>'` must fail HERE, because no assertion on the predicate
   * helper alone can see whether the query builder calls it.
   */
  it('sends a type filter that matches the NUMERIC spelling too', async () => {
    await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
      type: TransactionType.AppAuthorFee,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    const sql = sentSql();
    // A positive control on the mock: a zero here would make every assertion
    // below unreachable and this test green for no reason.
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) expect(q).toContain("type IN ('appAuthorFee','28')");
    // The spelling the base emitted, which matches no row the ingest MV wrote.
    for (const q of sql) expect(q).not.toContain("type = 'appAuthorFee'");
  });

  it('keeps the filter out of the SQL entirely when no type is asked for', async () => {
    await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    const sql = sentSql();
    expect(sql.length).toBeGreaterThan(0);
    // Word-anchored: the query also carries `toAccountType IN ('yellow')`, which a
    // plain `toContain('type IN (')` misses only because it is case-sensitive.
    // Renaming that column to snake_case would redden a healthy query.
    for (const q of sql) expect(q).not.toMatch(/\btype IN \(/);
  });

  /**
   * 🔴 THE WIRING GUARD FOR THE HYDRATOR, and the one that was missing entirely:
   * reverting `hydrateTransactions` to `TransactionType[capitalise(row.type)]`
   * must fail here. `toBe` is `Object.is`, so it separates the number 28 from
   * the string `'AppAuthorFee'` that the reverse mapping returns — which is what
   * rendered as a bare `28` on `/user/transactions`.
   */
  it('hydrates a row stored as its NUMBER into the member, not into the name', async () => {
    mockQuery.mockResolvedValueOnce([row({ type: '28', amount: 3 })]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    const [tx] = result.transactions;
    expect(tx.type).toBe(TransactionType.AppAuthorFee);
    // `toBe` is `Object.is`, so this alone separates the number 28 from the string
    // `'AppAuthorFee'` the reverse mapping returned. A `not.toBe('AppAuthorFee')`
    // after it could never report, and is deliberately absent.
    expect(tx.type).toBe(28);
    // NOT subsumed: a duplicate enum value at 28 flips the reverse map, and this is
    // the only line here that sees it.
    expect(TransactionType[tx.type]).toBe('AppAuthorFee');
    // The credit/debit sign, which nothing else on this path asserted.
    expect(tx.amount).toBe(3);
  });

  /**
   * The same row shape for the member that has been in this state since
   * 2026-05-21 — so the guard is not special-cased to one value, and the
   * pre-existing instance is covered by the same wiring.
   */
  it('hydrates the other past-26 member the same way', async () => {
    mockQuery.mockResolvedValueOnce([row({ type: '27', amount: 5 })]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    const [tx] = result.transactions;
    expect(tx.type).toBe(TransactionType.LicenseFee);
    expect(tx.type).toBe(27);
  });

  /**
   * The name path still works. Pinned because the fix replaced the expression
   * that handled it, so "the numeric case now works" is only half the claim.
   */
  it('still hydrates a row stored as its camelCase name', async () => {
    mockQuery.mockResolvedValueOnce([row({ type: 'appAuthorFee', amount: 2 })]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    const [tx] = result.transactions;
    expect(tx.type).toBe(TransactionType.AppAuthorFee);
    expect(tx.type).toBe(28);
  });
});

/**
 * 🔴 THE SECOND HYDRATION SITE. `formatExportBatch` resolves `row.type` on its own
 * line, independently of `hydrateTransactions`, so reverting only the export site
 * left every other test in this file green. The filter half IS shared — both paths
 * build their SQL through `buildBranchQuery` — which is exactly why the hydration
 * half needed its own guard rather than being assumed covered.
 */
describe('streamUserBuzzTransactionsCsv — the same seam on the export path', () => {
  /** Collect the whole streamed CSV, header included. */
  async function csv(over: Record<string, unknown> = {}) {
    const chunks: string[] = [];
    for await (const chunk of streamUserBuzzTransactionsCsv({
      accountId: ACCOUNT_ID,
      ...WINDOW,
      ...over,
    } as Parameters<typeof streamUserBuzzTransactionsCsv>[0]))
      chunks.push(chunk);
    return chunks.join('');
  }

  it('writes the member NAME for a row stored as its number, not the bare number', async () => {
    mockQuery.mockResolvedValueOnce([row({ type: '28', amount: 3 })]);

    const out = await csv();
    // A positive control: with no body row the assertions below are unreachable, and
    // a header-only file is itself one of the two symptoms under test.
    const lines = out.trim().split('\r\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(out).toContain('AppAuthorFee');
    // The symptom: the type column carrying the raw enum value.
    expect(lines[1]).not.toMatch(/(^|,)"?28"?,/);
  });

  it('does the same for the other past-26 member', async () => {
    mockQuery.mockResolvedValueOnce([row({ type: '27', amount: 5 })]);

    const out = await csv();
    expect(out.trim().split('\r\n').filter(Boolean).length).toBeGreaterThan(1);
    expect(out).toContain('LicenseFee');
  });

  it('still writes the name for a row stored as its camelCase name', async () => {
    mockQuery.mockResolvedValueOnce([row({ type: 'appAuthorFee', amount: 2 })]);

    const out = await csv();
    expect(out.trim().split('\r\n').filter(Boolean).length).toBeGreaterThan(1);
    expect(out).toContain('AppAuthorFee');
  });

  it('sends the numeric spelling of the type filter on the export query too', async () => {
    await csv({ type: TransactionType.AppAuthorFee });

    const sql = sentSql();
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) expect(q).toContain("type IN ('appAuthorFee','28')");
  });
});
