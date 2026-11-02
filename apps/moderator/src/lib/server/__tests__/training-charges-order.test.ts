import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();

// A kysely chain that resolves to no runs: only the ClickHouse side is under test.
const chain: unknown = new Proxy(() => chain, {
  get: (_t, prop) => (prop === 'execute' ? async () => [] : () => chain),
});
vi.mock('$lib/server/db', () => ({ dbRead: { selectFrom: () => chain }, dbWrite: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ $query: query }) }));

const { getTrainingRuns } = await import('../user-account.service');

const row = (id: string, date: string) => ({ id, date, buzz: '100', workflowId: '' });

beforeEach(() => query.mockReset());

describe('getTrainingRuns charges', () => {
  it('orders charges itself: the query is unordered, first/last/unmatched come out newest-first', async () => {
    query.mockResolvedValue([
      row('b', '2026-05-26 01:06:29'),
      row('c', '2026-07-01 00:00:00'),
      row('a', '2025-12-31 23:59:59'),
    ]);
    const { charges } = await getTrainingRuns(1);
    expect(query.mock.calls[0][0]).not.toMatch(/ORDER BY/i);
    expect(charges?.first).toBe('2025-12-31T23:59:59Z');
    expect(charges?.last).toBe('2026-07-01T00:00:00Z');
    expect(charges?.unmatched.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(charges?.count).toBe(3);
  });

  it('keeps the newest 200 unmatched charges and flags truncation', async () => {
    const rows = Array.from({ length: 205 }, (_, i) =>
      row(
        `t${i}`,
        `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(
          2,
          '0'
        )}`
      )
    ).reverse();
    query.mockResolvedValue(rows);
    const { charges } = await getTrainingRuns(1);
    expect(charges?.unmatched).toHaveLength(200);
    expect(charges?.unmatched[0].id).toBe('t204');
    expect(charges?.unmatched[199].id).toBe('t5');
    expect(charges?.truncated).toBe(true);
  });

  it('makes no ClickHouse call and returns null charges when charges:false', async () => {
    const res = await getTrainingRuns(1, 25, { charges: false });
    expect(query).not.toHaveBeenCalled();
    expect(res.charges).toBeNull();
  });
});
