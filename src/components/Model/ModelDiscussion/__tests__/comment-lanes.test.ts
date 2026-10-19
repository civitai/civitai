import { describe, expect, it } from 'vitest';
import { assignLanes } from '../comment-lanes';

const base = { estimate: 200, gap: 16, heights: new Map<number, number>() };

describe('assignLanes', () => {
  it('keeps existing ids in their lane when ids are appended, even if another column is now shorter', () => {
    const first = assignLanes({ ...base, ids: [1, 2, 3], columnCount: 2 });
    expect(first.columns).toEqual([[1, 3], [2]]);

    // Column 0 now measures far taller than column 1, which would re-place item 3 under a re-pick.
    const heights = new Map([
      [1, 900],
      [2, 100],
      [3, 100],
    ]);
    const next = assignLanes({
      ...base,
      heights,
      ids: [1, 2, 3, 4],
      columnCount: 2,
      previous: first.lanes,
    });
    expect(next.columns).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it('puts a new id in the shortest column using measured heights, else the estimate', () => {
    const first = assignLanes({ ...base, ids: [1, 2], columnCount: 2 });
    const next = assignLanes({
      ...base,
      heights: new Map([[1, 500]]),
      ids: [1, 2, 3],
      columnCount: 2,
      previous: first.lanes,
    });
    expect(next.lanes.byId.get(3)).toBe(1);
  });

  it('re-places everything in order when the column count changes', () => {
    const first = assignLanes({ ...base, ids: [1, 2, 3, 4], columnCount: 2 });
    const next = assignLanes({ ...base, ids: [1, 2, 3, 4], columnCount: 3, previous: first.lanes });
    expect(next.columns).toEqual([[1, 4], [2], [3]]);
  });

  it('places a duplicated id once', () => {
    const { columns } = assignLanes({ ...base, ids: [1, 2, 1], columnCount: 2 });
    expect(columns).toEqual([[1], [2]]);
  });
});
