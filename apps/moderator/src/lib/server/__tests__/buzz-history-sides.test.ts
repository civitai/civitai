import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Both sides used to share one `LIMIT 200`, and a revert reads as "Payments (0)" beside a full receipts
 * column — indistinguishable from an account that has never spent Buzz. So: separate queries, separate
 * truncation flags. Background in `getBuzzHistory`.
 */

const queries = vi.hoisted(() => [] as string[]);
const rowsFor = vi.hoisted(() => ({ out: 0, in: 0 }));
const typesFor = vi.hoisted(() => ({ out: [] as string[], in: [] as string[] }));

/** The row fetch and the type aggregate hit the same table on the same side; only one is capped. */
const isTypeQuery = (q: string) => /SELECT DISTINCT type/.test(q);

const row = (i: number, direction: 'in' | 'out') => ({
  transactionId: `${direction}-${i}`,
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
      // The query names the side: `fromAccountId = <user>` is money out, `toAccountId` money in.
      const direction = /fromAccountId = \d+/.test(q) ? 'out' : 'in';
      if (isTypeQuery(q)) return Promise.resolve(typesFor[direction].map((type) => ({ type })));
      return Promise.resolve(
        Array.from({ length: rowsFor[direction] }, (_, i) => row(i, direction))
      );
    },
  }),
}));

vi.mock('../users.service', () => ({ usersByIds: () => Promise.resolve(new Map()) }));
vi.mock('../db', () => ({ dbRead: {} }));
vi.mock('../buzz', () => ({ getBuzz: () => ({}) }));
vi.mock('../notifications', () => ({ getNotifications: () => Promise.resolve([]) }));
vi.mock('../moderator-db', () => ({ getModeratorDb: () => ({}) }));

const { getBuzzHistory } = await import('../user-account.service');

describe('getBuzzHistory', () => {
  beforeEach(() => {
    queries.length = 0;
    Object.assign(rowsFor, { out: 0, in: 0 });
    Object.assign(typesFor, { out: [], in: [] });
  });

  it('asks for each side separately, one row past its own cap', async () => {
    await getBuzzHistory(7, 90, { limit: 200 });

    const rowQueries = queries.filter((q) => !isTypeQuery(q));
    expect(rowQueries).toHaveLength(2);
    expect(rowQueries.filter((q) => /fromAccountId = 7/.test(q))).toHaveLength(1);
    expect(rowQueries.filter((q) => /toAccountId = 7/.test(q))).toHaveLength(1);
    for (const q of rowQueries) expect(q).toContain('LIMIT 201');
  });

  it('returns the payments of an account whose receipts fill the cap', async () => {
    Object.assign(rowsFor, { in: 5000, out: 3 });

    const history = await getBuzzHistory(7, 90, { limit: 200 });

    expect(history.payments).toHaveLength(3);
    expect(history.receipts).toHaveLength(200);
  });

  it('flags truncation per side rather than across both', async () => {
    Object.assign(rowsFor, { in: 5000, out: 3 });

    const history = await getBuzzHistory(7, 90, { limit: 200 });

    expect(history.truncated).toEqual({ payments: false, receipts: true });
  });

  it('labels each side by the query it came from, not by comparing account ids', async () => {
    Object.assign(rowsFor, { in: 2, out: 2 });

    const history = await getBuzzHistory(7, 90, { limit: 200 });

    expect(history.payments.every((t) => t.direction === 'out')).toBe(true);
    expect(history.receipts.every((t) => t.direction === 'in')).toBe(true);
  });

  it('hides bank rows without shortening the window it reports', async () => {
    Object.assign(rowsFor, { in: 201, out: 0 });

    const history = await getBuzzHistory(7, 90, { limit: 200, includeBank: false });

    expect(history.truncated.receipts).toBe(true);
  });
});

/**
 * The type filter used to run on the CLIENT, over rows already capped at 200. Narrowing cannot reach
 * what was never fetched, so on a reward-heavy account selecting "purchase" returned whatever handful
 * of purchases happened to survive the cap — measured across 300 crypto buyers, 52% of their purchases
 * were outside the newest 200 receipts and unreachable at any window. The dropdown was built the same
 * way, from the loaded page, so a type the cap pushed out could not even be selected.
 *
 * Both halves have to hold: the filter reaches the SQL *before* the cap, and the options come from the
 * whole window rather than the page.
 */
describe('the per-side type filter', () => {
  beforeEach(() => {
    queries.length = 0;
    Object.assign(rowsFor, { out: 0, in: 0 });
    Object.assign(typesFor, { out: [], in: [] });
  });

  const rowQuery = (side: 'out' | 'in') =>
    queries
      .filter((q) => !isTypeQuery(q))
      .find((q) => /fromAccountId = 7/.test(q) === (side === 'out'))!;

  it('narrows only the side it was given, in the SQL', async () => {
    await getBuzzHistory(7, 90, { limit: 200, receiptType: 'purchase' });

    expect(rowQuery('in')).toContain("AND type = 'purchase'");
    // The two columns filter independently; leaking one side's choice onto the other would silently
    // answer a question nobody asked.
    expect(rowQuery('out')).not.toContain('AND type =');
  });

  it('caps AFTER filtering, so a type selection fetches that many OF that type', async () => {
    await getBuzzHistory(7, 90, { limit: 200, receiptType: 'purchase' });

    const q = rowQuery('in');
    const filterAt = q.indexOf("AND type = 'purchase'");
    const limitAt = q.indexOf('LIMIT');

    // Assert PRESENCE before ordering: `indexOf` is -1 when the filter is missing, which is less than
    // any real index, so an ordering check alone passes vacuously on the very revert it guards against.
    expect(filterAt).toBeGreaterThan(-1);
    // Order is the whole fix: filter then LIMIT returns 200 purchases; LIMIT then filter returns
    // whatever share of 200 mixed rows happened to be purchases.
    expect(filterAt).toBeLessThan(limitAt);
  });

  it('reads the options from the whole window, not the capped page', async () => {
    Object.assign(typesFor, { out: ['tip'], in: ['purchase', 'reward'] });
    // Deliberately zero rows: the options must not be derived from them.
    const history = await getBuzzHistory(7, 90, { limit: 200 });

    expect(history.types).toEqual({ payments: ['tip'], receipts: ['purchase', 'reward'] });
    for (const q of queries.filter(isTypeQuery)) expect(q).not.toContain('LIMIT');
  });

  it('never offers a type whose rows the caller may not see', async () => {
    Object.assign(typesFor, { out: ['bank', 'tip'], in: ['bank'] });

    const history = await getBuzzHistory(7, 90, { limit: 200, includeBank: false });

    // Bank rows are stripped from the results, so offering `bank` would be a filter that always
    // returns nothing — which reads as "no such transactions" rather than as a permission.
    expect(history.types).toEqual({ payments: ['tip'], receipts: [] });
  });

  it('refuses a type that is not a bare identifier rather than interpolating it', async () => {
    // `$query` does no escaping, so this value reaches the SQL as text. Dropping to "no filter" is the
    // safe failure; passing it through is an injection.
    await getBuzzHistory(7, 90, { limit: 200, receiptType: "purchase' OR '1'='1" });

    expect(rowQuery('in')).not.toContain("OR '1'='1");
    expect(rowQuery('in')).not.toContain('AND type =');
  });
});
