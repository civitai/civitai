import { describe, expect, it } from 'vitest';
import { recentFirst, recentInRange } from '../content-sort';

type Row = { id: number; createdAt: string | null };
const id = (r: Row) => r.id;

describe('recentFirst', () => {
  it('orders newest first regardless of input order', () => {
    const rows: Row[] = [
      { id: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 3, createdAt: '2026-03-01T00:00:00.000Z' },
      { id: 2, createdAt: '2026-02-01T00:00:00.000Z' },
    ];
    expect(recentFirst(rows, id).map(id)).toEqual([3, 2, 1]);
  });

  it('breaks equal timestamps by id, higher first', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const rows: Row[] = [
      { id: 5, createdAt: at },
      { id: 9, createdAt: at },
      { id: 7, createdAt: at },
    ];
    expect(recentFirst(rows, id).map(id)).toEqual([9, 7, 5]);
  });

  it('sorts a missing timestamp last, however many there are', () => {
    const rows: Row[] = [
      { id: 10, createdAt: null },
      { id: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 11, createdAt: null },
    ];
    expect(recentFirst(rows, id).map(id)).toEqual([1, 11, 10]);
  });

  it('does not mutate its input', () => {
    const rows: Row[] = [
      { id: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, createdAt: '2026-02-01T00:00:00.000Z' },
    ];
    recentFirst(rows, id);
    expect(rows.map(id)).toEqual([1, 2]);
  });
});

describe('recentInRange', () => {
  const c = (projectId: number, createdAt: string) => ({ projectId, createdAt });
  const rows = [
    c(1, '2026-08-31T23:59:00.000Z'),
    c(2, '2026-09-01T00:00:00.000Z'),
    c(3, '2026-09-30T23:59:59.000Z'),
    c(4, '2026-10-01T00:00:00.000Z'),
  ];

  it('keeps only items created inside the inclusive day range, newest first', () => {
    expect(
      recentInRange(rows, '2026-09-01', '2026-09-30', (r) => r.projectId).map((r) => r.projectId)
    ).toEqual([3, 2]);
  });

  it('caps the result', () => {
    expect(
      recentInRange(rows, '2026-08-01', '2026-10-31', (r) => r.projectId, 2).map((r) => r.projectId)
    ).toEqual([4, 3]);
  });

  it('drops an item with no createdAt', () => {
    expect(
      recentInRange(
        [{ projectId: 9, createdAt: null }],
        '2026-01-01',
        '2026-12-31',
        (r) => r.projectId
      )
    ).toEqual([]);
  });
});
