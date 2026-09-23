import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Buzz ledger is two columns that share nothing: each has its own type filter, its own paging, and
 * its own cap. Three defects came from treating them as one thing, and each was invisible in a way the
 * next one was not.
 *
 * ONE cap across both sides let the busy side eat it — measured on user 2557503, all 200 rows of a
 * 90-day window were receipts spanning two days, so every one of its 128 payments was invisible.
 *
 * ONE client-side filter over that page could only shrink what was already fetched, so selecting a type
 * returned whatever share of the page happened to match. Across 300 accounts that bought Buzz with
 * crypto, 52% of their purchases were outside the newest 200 receipts and unreachable at any window.
 *
 * ONE request for both sides made either column's filter reload the other, blanking a column whose
 * answer had not changed.
 */

const queries = vi.hoisted(() => [] as string[]);
const rowCount = vi.hoisted(() => ({ n: 0 }));
const typeList = vi.hoisted(() => ({ types: [] as string[] }));

/** The row fetch and the type aggregate hit the same table on the same side; only one is capped. */
const isTypeQuery = (q: string) => /SELECT DISTINCT type/.test(q);

const row = (i: number) => ({
  transactionId: `t-${i}`,
  date: '2026-09-18 14:33:35',
  amount: '10',
  accountType: 'yellow',
  counterpartyType: 'yellow',
  type: 'purchase',
  description: '',
  externalTransactionId: '',
  counterpartyId: '0',
});

vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    $query: (q: string) => {
      queries.push(q);
      if (isTypeQuery(q)) return Promise.resolve(typeList.types.map((type) => ({ type })));
      return Promise.resolve(Array.from({ length: rowCount.n }, (_, i) => row(i)));
    },
  }),
}));

vi.mock('../users.service', () => ({ usersByIds: () => Promise.resolve(new Map()) }));
vi.mock('../db', () => ({ dbRead: {} }));
vi.mock('../buzz', () => ({ getBuzz: () => ({}) }));
vi.mock('../notifications', () => ({ getNotifications: () => Promise.resolve([]) }));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => ({}) }));

const { getBuzzLedgerSide, getBuzzLedgerTypes } = await import('../user-account.service');

const rowQuery = () => queries.find((q) => !isTypeQuery(q))!;

beforeEach(() => {
  queries.length = 0;
  rowCount.n = 0;
  typeList.types = [];
});

describe('each side is queried alone', () => {
  it('reads only its own side of the ledger', async () => {
    await getBuzzLedgerSide(7, 'payments', 90, { limit: 200 });

    // This is what lets one column reload without the other. Touching `toAccountId` here would put the
    // receipts query back on the payments request, and nothing on screen would show it.
    for (const q of queries) {
      expect(q).toContain('fromAccountId = 7');
      expect(q).not.toContain('toAccountId = 7');
    }
  });

  it('asks the other column for the other side', async () => {
    await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200 });

    for (const q of queries) {
      expect(q).toContain('toAccountId = 7');
      expect(q).not.toContain('fromAccountId = 7');
    }
  });

  it('fetches one row past its cap, so truncation is known rather than guessed', async () => {
    rowCount.n = 201;

    const side = await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200 });

    expect(rowQuery()).toContain('LIMIT 201');
    expect(side.rows).toHaveLength(200);
    expect(side.truncated).toBe(true);
  });

  it('is not truncated when the window ends exactly at the cap', async () => {
    rowCount.n = 200;

    // The boundary a `>=` gets wrong in the direction nobody checks: 200 of 200 must read "200", not
    // "200+".
    expect((await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200 })).truncated).toBe(false);
  });

  it('labels rows by the side that was asked for, not by comparing account ids', async () => {
    rowCount.n = 2;

    const payments = await getBuzzLedgerSide(7, 'payments', 90, { limit: 200 });
    const receipts = await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200 });

    expect(payments.rows.every((t) => t.direction === 'out')).toBe(true);
    expect(receipts.rows.every((t) => t.direction === 'in')).toBe(true);
  });

  it('hides bank rows without shortening the window it reports', async () => {
    rowCount.n = 201;

    // Filtering after the cap: a moderator who cannot see bank rows must not also be told the window
    // was complete when it was cut.
    const side = await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200, includeBank: false });

    expect(side.truncated).toBe(true);
  });
});

describe('the type filter', () => {
  it('narrows in the SQL rather than in the result', async () => {
    await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200, type: 'purchase' });

    expect(rowQuery()).toContain("AND type = 'purchase'");
  });

  it('caps AFTER filtering, so a selection fetches that many OF that type', async () => {
    await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200, type: 'purchase' });

    const q = rowQuery();
    const filterAt = q.indexOf("AND type = 'purchase'");
    const limitAt = q.indexOf('LIMIT');

    // Assert PRESENCE before ordering: `indexOf` is -1 when the filter is missing, which is less than
    // any real index, so an ordering check alone passes vacuously on the very revert it guards against.
    expect(filterAt).toBeGreaterThan(-1);
    // Filter then LIMIT returns 200 purchases; LIMIT then filter returns whatever share of 200 mixed
    // rows happened to be purchases.
    expect(filterAt).toBeLessThan(limitAt);
  });

  it('refuses a type that is not a bare identifier rather than interpolating it', async () => {
    // `$query` does no escaping, so this value reaches the SQL as text. Dropping to "no filter" is the
    // safe failure; passing it through is an injection.
    await getBuzzLedgerSide(7, 'receipts', 90, { limit: 200, type: "purchase' OR '1'='1" });

    expect(rowQuery()).not.toContain("OR '1'='1");
    expect(rowQuery()).not.toContain('AND type =');
  });
});

/**
 * The options are their own query, depending on the window alone — not on the cap, and not on the type
 * currently selected. Folded into the row fetch they reloaded on every selection, and the control
 * disappeared while they did, which is precisely when a moderator who picked the wrong type wants to
 * pick another.
 */
describe('the filter options', () => {
  it('are read across the whole window, never from a capped page', async () => {
    typeList.types = ['purchase', 'reward'];

    const types = await getBuzzLedgerTypes(7, 90);

    expect(types).toEqual({ payments: ['purchase', 'reward'], receipts: ['purchase', 'reward'] });
    // A cap here would make the list describe what survived it — and a type it dropped is exactly the
    // one nobody could then select, when selecting it is the only thing that would fetch it.
    for (const q of queries) expect(q).not.toContain('LIMIT');
  });

  it('do not depend on the selected type, so choosing one cannot reload them', async () => {
    await getBuzzLedgerTypes(7, 90);

    for (const q of queries) expect(q).not.toContain('AND type =');
  });

  it('cover both sides in one request', async () => {
    await getBuzzLedgerTypes(7, 90);

    expect(queries.some((q) => q.includes('fromAccountId = 7'))).toBe(true);
    expect(queries.some((q) => q.includes('toAccountId = 7'))).toBe(true);
  });

  it('never offer a type whose rows the caller may not see', async () => {
    typeList.types = ['bank', 'tip'];

    const types = await getBuzzLedgerTypes(7, 90, { includeBank: false });

    // Offering `bank` would be a filter that always returns nothing, which reads as "no such
    // transactions" rather than as a permission.
    expect(types).toEqual({ payments: ['tip'], receipts: ['tip'] });
  });
});
