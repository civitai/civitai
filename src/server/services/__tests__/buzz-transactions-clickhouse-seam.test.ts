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
 *   - the SQL it sends carries the `unknown_<n>` spelling of the type filter,
 *     because a name-only predicate silently matches nothing for a member the
 *     ingest MV cannot name (prod stores `AppAuthorFee` only as `'unknown_28'`)
 *   - a row whose `type` column holds `'unknown_28'` (or a bare `'28'`) comes
 *     back as the NUMBER 28, not `Tip` and not the string `'AppAuthorFee'`
 *
 * 🔴 BOTH READ PATHS, and they are two independent expressions. The list
 * (`hydrateTransactions`) and the CSV export (`formatExportBatch`) each resolve
 * `row.type` on their own line; only the list one was covered when this file was
 * first written, so reverting the export site alone survived the whole suite. The
 * CSV column reading `28` is the symptom a user cannot work around, so it gets its
 * own tests rather than riding on the shared filter.
 *
 * ── WHAT IS MOCKED ──────────────────────────────────────────────────────────
 * This file mocks TWO modules: the ClickHouse client (the seam under test — the
 * mock is how the SQL is captured and the row shape injected) and `getUsers`. The
 * logger is NOT one of them — `src/__tests__/setup.ts` already mocks it, along
 * with the db, redis, env, prom and four others; the lines below only configure
 * that existing mock. So "only the edges" describes this file, not the process the
 * tests run in.
 *
 * `buildBranchQuery`, `walkTransactionSlices`, `hydrateTransactions` and
 * `formatExportBatch` all run for real, which is the point.
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
/**
 * 🔴 A SECOND account id, used by the self-transfer tests. Their property -
 * `from === to === accountId` is a debit - does not depend on WHICH account, so
 * running them at the module constant was incidental and made a predicate that
 * hardcodes `ACCOUNT_ID` indistinguishable from one reading the argument.
 */
const OTHER_ACCOUNT_ID = 909;

/** A row as ClickHouse hands it over: every column a string or a number. */
function row(over: Record<string, unknown> = {}) {
  return {
    transactionId: '00000000-0000-0000-0000-000000000001',
    date: '2026-09-26 16:51:00',
    type: 'tip',
    amount: 11,
    fromAccountId: 77,
    toAccountId: ACCOUNT_ID,
    // A real `BuzzAccountType`, and one the own-side filter admits — tests that do
    // not care about this column still must not pin it to a value production cannot
    // emit (it was `'user'`, which is not a member at all).
    fromAccountType: 'blue',
    toAccountType: 'blue',
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
  // Required by the schema and by `buildBranchQuery`, which maps over it. All three
  // spend types, which is also the schema's own default — so no account type this
  // file ASSERTS is one the own-side filter could never admit.
  //
  // 🔴 A mutant reporting the REQUESTED filter instead of the row's own side is
  // killed by the fixtures, not by this list: no single value satisfies the
  // account-type expectations below, because two of them are at the SAME direction
  // and differ. See the note on those tests before changing any of them.
  accountTypes: ['blue', 'green', 'yellow'] as const,
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
  it('sends a type filter that matches the unknown_<n> and NUMERIC spellings too', async () => {
    await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
      type: TransactionType.AppAuthorFee,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    const sql = sentSql();
    // A positive control on the mock: a zero here would make every assertion
    // below unreachable and this test green for no reason.
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) expect(q).toContain("type IN ('appAuthorFee','28','unknown_28')");
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
    // The `to`-direction query legitimately carries
    // `toAccountType IN ('blue','green','yellow')`, and TODAY only capitalisation
    // keeps that out of a bare `type IN (` search — the `\b` contributes nothing
    // against it.
    //
    // What the anchor buys is the FUTURE spelling: rename that column to
    // `to_account_type` (or any lowercase `…type`) and a bare pattern matches it,
    // false-reddening a perfectly healthy query. `\b` does not match there because
    // `_` is a word character, so the anchor is what keeps this assertion about OUR
    // predicate. Measured both ways rather than reasoned — two earlier versions of
    // this comment had it backwards in both directions.
    for (const q of sql) expect(q).not.toMatch(/\btype IN \(/);
  });

  /**
   * 🔴 THE WIRING GUARD FOR THE HYDRATOR: reverting `hydrateTransactions` to
   * `TransactionType[capitalise(row.type)]` must fail here. `'unknown_28'` is the
   * spelling prod stores, and that expression resolves it to `Tip`.
   */
  it('hydrates a row stored as unknown_28 into the member, not into Tip', async () => {
    mockQuery.mockResolvedValueOnce([
      // 🔴 CREDIT CASE ONE OF TWO, AND THE TWO MUST DIFFER. Distinct pairs alone are
      // not enough: with one credit case and one debit case, ANY pure function of
      // the direction reproduces both while reading nothing from the row, and such a
      // mutant survived the whole suite twice. What kills it is two cases at the
      // SAME direction with DIFFERENT expected values — this one and
      // `hydrates a member stored as its bare number` below. Keep them different.
      // 🔴 And a counterparty id that is NOT the `77` the other rows use, for the
      // same reason the export suite varies one: a sign or side predicate keyed on a
      // LITERAL id agrees with one keyed on `accountId` on every row where the
      // counterparty is always the same, so the double-inverted mutant
      // (`=== 77 ? +amount : -amount`) is equivalent and survives.
      row({
        type: 'unknown_28',
        amount: 3,
        fromAccountId: 5555,
        fromAccountType: 'green',
        toAccountType: 'blue',
      }),
    ]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    const [tx] = result.transactions;
    expect(tx.type).toBe(TransactionType.AppAuthorFee);
    expect(tx.type).toBe(28);
    // NOT subsumed by the line above: a duplicate enum value at 28 flips the
    // reverse map, and this reports it directly rather than as a knock-on.
    expect(TransactionType[tx.type]).toBe('AppAuthorFee');
    // A CREDIT — this row's counterparty is the payer — so the magnitude ClickHouse
    // stores comes back unchanged. The debit direction is the one worth guarding and
    // it gets its own test below.
    expect(tx.amount).toBe(3);
    expect(tx.fromAccountType).toBe('green');
    expect(tx.toAccountType).toBe('blue');
  });

  /**
   * 🔴 THE SIGN, on both read paths. ClickHouse stores every amount as a positive
   * magnitude and the direction lives in which side of the transaction the account
   * is on, so a fee the viewer PAID and a fee the author RECEIVED are the same
   * stored row read from two accounts. Dropping the negation made no test fail:
   * every fixture here was a credit, so the flip was asserted only in its trivial
   * direction.
   */
  it('negates the amount when the account is the PAYER, on the list path', async () => {
    mockQuery.mockResolvedValueOnce([
      row({
        type: '28',
        amount: 3,
        fromAccountId: ACCOUNT_ID,
        toAccountId: 77,
        // The DEBIT direction's pair. The distinctness that matters is between the
        // two CREDIT cases — one above this test, one below — not between a credit
        // and this one. See their notes.
        fromAccountType: 'blue',
        toAccountType: 'yellow',
      }),
    ]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(-3);
    // The list path has no `isDebit` branch here — it passes BOTH sides through
    // unchanged — so this pins the passthrough, and swapping the two reddens it.
    expect(result.transactions[0].fromAccountType).toBe('blue');
    expect(result.transactions[0].toAccountType).toBe('yellow');
  });

  /**
   * 🔴 THE DIRECTION DISCRIMINATOR, not just which side gets reported. Every other
   * fixture puts `ACCOUNT_ID` and `77` in fixed operand positions, so any predicate
   * that merely AGREES with `row.fromAccountId === accountId` on that one pair
   * survives — including `row.toAccountId !== accountId`, which is realistic and
   * wrong for the case `buzz.service.ts` documents in `fetchTransactionBranches` (a
   * long way from either direction branch): a transfer between the caller's own
   * accounts matches BOTH sides. Production calls
   * that a debit; the mutant calls it a credit, flipping the sign and, on the export
   * path, the account-type column too.
   */
  it('treats a transfer between the account and itself as a DEBIT', async () => {
    mockQuery.mockResolvedValueOnce([
      row({
        type: '28',
        amount: 9,
        // 🔴 `OTHER_ACCOUNT_ID`, not the module constant. The property under test is
        // `from === to === accountId`, which holds for ANY account — so running it at
        // `ACCOUNT_ID` let a predicate hardcoding that literal pass, and the test
        // could not tell "self-transfer is a debit" from "account 4242 is a debit".
        fromAccountId: OTHER_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
        fromAccountType: 'green',
        toAccountType: 'yellow',
      }),
    ]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: OTHER_ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].amount).toBe(-9);
  });

  // The bare-digit spelling, for a second member, so the guard is not
  // special-cased to one value or one spelling.
  it('hydrates a member stored as its bare number the same way', async () => {
    mockQuery.mockResolvedValueOnce([
      // 🔴 CREDIT CASE TWO OF TWO — same direction as the `'unknown_28'` case above, and its
      // account types DELIBERATELY DIFFER from it. A constant substituted for any
      // DIRECTION-DEPENDENT column (the amount, either side) dies somewhere in the
      // file, though never in the case whose own expected value it copies; the date
      // and raw id columns are asserted nowhere and constants there survive. What this
      // PAIR buys is the direction-function class: `? -row.amount : 3` and
      // `from <= accountId` die at this test and nowhere else.
      row({ type: '27', amount: 5, fromAccountType: 'yellow', toAccountType: 'green' }),
    ]);

    const result = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(result.transactions).toHaveLength(1);
    const [tx] = result.transactions;
    expect(tx.type).toBe(TransactionType.LicenseFee);
    expect(tx.type).toBe(27);
    // 🔴 The amount, which was unasserted here, and load-bearing on THIS path: the
    // list result has no other observer of the direction, so without it a relational
    // mutant (`from <= accountId`) survives. It is not what kills a predicate keyed on
    // a literal ID — the self-transfer tests do that, on both paths, by running at a
    // second account id.
    expect(tx.amount).toBe(5);
    expect(tx.fromAccountType).toBe('yellow');
    expect(tx.toAccountType).toBe('green');
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

  it('writes the member NAME for a row stored as unknown_28, not Tip', async () => {
    // 🔴 CREDIT CASE ONE OF TWO on this path, and it must differ from the other
    // credit (`reports the RECIPIENT side …`). Two cases differing only in direction
    // are satisfied by any pure function of `isDebit` without reading the row — that
    // mutant survived the whole suite until a second credit with a different value
    // existed.
    mockQuery.mockResolvedValueOnce([
      row({ type: 'unknown_28', amount: 3, fromAccountType: 'green', toAccountType: 'blue' }),
    ]);

    const out = await csv();
    // A positive control: with no body row the assertions below are unreachable, and
    // a header-only file is itself one of the two symptoms under test.
    const lines = out.trim().split('\r\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    // Column-anchored on the STATE, not searched for a spelling. `type` is field 1
    // (`EXPORT_COLUMNS`), and the rows this generator emits are unquoted. A
    // whole-line `/(^|,)28,/` search would have matched the AMOUNT column instead,
    // and passed only because the fixture happens not to use 28 as an amount.
    expect(lines[1].split(',')[1]).toBe('AppAuthorFee');
    // A credit, so the RECIPIENT side — and distinct from the other credit's. This
    // also pins `isDebit === false` for this row, which is why an amount assertion
    // here would be a second read of the same bit and is deliberately absent — on the
    // export path the side column is an observer of the direction, so the list path's
    // amount assertion has no twin here.
    expect(lines[1].split(',')[3]).toBe('blue');
  });

  /**
   * The direction discriminator on this path. Same reasoning as the list suite's
   * self-transfer test: a predicate agreeing with `fromAccountId === accountId` on
   * the fixtures' single id pair survives, and a self-transfer is where production's
   * answer (debit) and the plausible wrong one diverge — here flipping the
   * account-type column as well as the sign.
   */
  it('treats a self-transfer as a DEBIT, reporting the payer side', async () => {
    mockQuery.mockResolvedValueOnce([
      row({
        type: '28',
        amount: 9,
        // `OTHER_ACCOUNT_ID` for the same reason as the list suite's twin.
        fromAccountId: OTHER_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
        fromAccountType: 'green',
        toAccountType: 'yellow',
      }),
    ]);

    const fields = (await csv({ accountId: OTHER_ACCOUNT_ID }))
      .trim()
      .split('\r\n')
      .filter(Boolean)[1]
      .split(',');
    expect(fields[2]).toBe('-9');
    expect(fields[3]).toBe('green');
  });

  it('does the same for a member stored as its bare number', async () => {
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

  /**
   * 🔴 THE SAME SIGN GUARD, and the export carries a SECOND branch the list does
   * not: `isDebit` also chooses which side's account type is reported. Dropping
   * either failed nothing — every fixture was a credit. Columns are
   * `date,type,amount,accountType,fromUser,toUser,…` per `EXPORT_COLUMNS`.
   *
   * 🔴 THE TWO EXPECTED ACCOUNT TYPES MUST DIFFER FROM EACH OTHER. Both cases
   * originally expected `'yellow'`, so replacing the whole branch with the literal
   * `'yellow'` passed — the direction was pinned while "does this column read the
   * row at all" was not.
   *
   * 🔴 AND THE COUNTERPARTY IDS MUST NOT ALL BE THE SAME. With every row using only
   * `ACCOUNT_ID` and one other id, a mutant that inverts BOTH the predicate and the
   * branches — `row.fromAccountId === 77 ? toAccountType : fromAccountType` — is
   * EQUIVALENT on every fixture and survives. It is only distinguishable on a row
   * whose counterparty is neither of those ids, which is why the credit case below
   * uses a third one, ABOVE `ACCOUNT_ID` so a relational operator dies too.
   */
  it('negates the amount and reports the PAYER side account type', async () => {
    mockQuery.mockResolvedValueOnce([
      row({
        type: '28',
        amount: 3,
        fromAccountId: ACCOUNT_ID,
        toAccountId: 77,
        fromAccountType: 'yellow',
        toAccountType: 'green',
      }),
    ]);

    const fields = (await csv()).trim().split('\r\n').filter(Boolean)[1].split(',');
    expect(fields[1]).toBe('AppAuthorFee');
    expect(fields[2]).toBe('-3');
    // The payer's side, not the recipient's — `green` here is the wrong answer.
    expect(fields[3]).toBe('yellow');
  });

  it('reports the RECIPIENT side account type when the account was paid', async () => {
    mockQuery.mockResolvedValueOnce([
      row({
        type: '28',
        amount: 3,
        // 🔴 A THIRD counterparty id, not the `77` every other fixture uses. This is
        // what makes a predicate keyed on a literal id distinguishable from one keyed
        // on `accountId` — see the note above; with `77` here the two agree on every
        // row and the mutant is equivalent.
        fromAccountId: 5555,
        toAccountId: ACCOUNT_ID,
        fromAccountType: 'yellow',
        toAccountType: 'green',
      }),
    ]);

    const fields = (await csv()).trim().split('\r\n').filter(Boolean)[1].split(',');
    expect(fields[2]).toBe('3');
    // Distinct from the case above, so a constant cannot satisfy both.
    expect(fields[3]).toBe('green');
  });

  it('sends the numeric spelling of the type filter on the export query too', async () => {
    await csv({ type: TransactionType.AppAuthorFee });

    const sql = sentSql();
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) expect(q).toContain("type IN ('appAuthorFee','28','unknown_28')");
  });
});
