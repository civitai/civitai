import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Both sides used to share one `LIMIT 200`, and a revert reads as "Payments (0)" beside a full receipts
 * column — indistinguishable from an account that has never spent Buzz. So: separate queries, separate
 * truncation flags. Background in `getBuzzHistory`.
 */

const queries = vi.hoisted(() => [] as string[]);
const rowsFor = vi.hoisted(() => ({ out: 0, in: 0 }));

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
  });

  it('asks for each side separately, one row past its own cap', async () => {
    await getBuzzHistory(7, 90, { limit: 200 });

    expect(queries).toHaveLength(2);
    expect(queries.filter((q) => /fromAccountId = 7/.test(q))).toHaveLength(1);
    expect(queries.filter((q) => /toAccountId = 7/.test(q))).toHaveLength(1);
    for (const q of queries) expect(q).toContain('LIMIT 201');
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
