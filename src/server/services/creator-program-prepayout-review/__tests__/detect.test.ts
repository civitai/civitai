import { describe, expect, it, vi } from 'vitest';
import { loadBatch, loadEarnings, loadPriorPayouts, periodWindow } from '../detect';

// ClickHouse returns UInt64/Int64 columns as strings.
const fakeClickhouse = (rows: object[]) => ({ $query: vi.fn(async () => rows) });

describe('periodWindow', () => {
  it('covers the calendar month and names the months before it', () => {
    expect(periodWindow('2026-01', 4)).toEqual({
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
      priorPeriods: ['2025-12', '2025-11', '2025-10', '2025-09'],
    });
  });
});

describe('loadBatch', () => {
  it('reads the period pool credits as numbers', async () => {
    const ch = fakeClickhouse([{ userId: '12', payoutCents: '3400' }]);

    expect(await loadBatch(ch, '2026-10')).toEqual([{ userId: 12, payoutCents: 3_400 }]);
    expect(ch.$query.mock.calls[0][0]).toContain("'comp-pool-unified-2026-10-'");
  });

  it('refuses a malformed period rather than interpolating it', async () => {
    await expect(loadBatch(fakeClickhouse([]), "2026-10' OR 1=1 --")).rejects.toThrow();
  });
});

describe('loadPriorPayouts', () => {
  it('lists each creator payouts most recent first, skipping months without one', async () => {
    const ch = fakeClickhouse([
      { userId: '12', period: '2026-07', payoutCents: '100' },
      { userId: '12', period: '2026-09', payoutCents: '300' },
      { userId: '13', period: '2026-08', payoutCents: '200' },
    ]);

    const prior = await loadPriorPayouts(ch, [12, 13], '2026-10', 4);

    expect(prior.get(12)).toEqual([300, 100]);
    expect(prior.get(13)).toEqual([200]);
  });
});

describe('loadEarnings', () => {
  it('reads totals and per-payer amounts within the period, as numbers', async () => {
    const ch = {
      $query: vi.fn(async (sql: string) =>
        sql.includes('LEFT JOIN')
          ? [{ userId: '12', payerId: '77', received: '500', sent: '40' }]
          : [{ userId: '12', amount: '900' }]
      ),
    };

    const { bankable, counterparties } = await loadEarnings(ch, [12], '2026-10');

    expect(bankable.get(12)).toBe(900);
    expect(counterparties.get(12)).toEqual([{ userId: 77, received: 500, sent: 40 }]);
    for (const [sql] of ch.$query.mock.calls)
      expect(sql).toContain("date >= '2026-10-01 00:00:00' AND date < '2026-11-01 00:00:00'");
  });
});
