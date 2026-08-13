import { describe, expect, it } from 'vitest';
import { capPerUser } from '~/components/HomeBlocks/homeBlockItems';

type Item = { id: number; user?: { id: number } | null };

// Item ids start at 100 so a test can mix these with hand-built items without an id collision
// silently making an assertion pass for the wrong item.
const byUser = (userIds: number[]): Item[] =>
  userIds.map((userId, index) => ({ id: 100 + index, user: { id: userId } }));

describe('capPerUser', () => {
  it('caps one creator and backfills the slice from the rest of the pool', () => {
    // A curator's own work first in the pool — the shape Demian reported on the home page.
    const pool = byUser([1, 1, 1, 1, 1, 2, 3, 4]);

    const result = capPerUser(pool, 5, 2);

    expect(result.filter((i) => i.user?.id === 1)).toHaveLength(2);
    // Backfilled rather than left short: a naive slice-then-cap would return 2 items here.
    expect(result).toHaveLength(5);
    expect(result.map((i) => i.user?.id)).toEqual([1, 1, 2, 3, 4]);
  });

  it('returns fewer than the slice when the pool cannot fill it under the cap', () => {
    const result = capPerUser(byUser([1, 1, 1, 1]), 5, 2);

    expect(result).toHaveLength(2);
  });

  it('keeps items with no resolvable creator', () => {
    const pool: Item[] = [{ id: 1 }, { id: 2, user: null }, ...byUser([1, 1, 1])];

    const result = capPerUser(pool, 4, 1);

    expect(result.map((i) => i.id)).toEqual([1, 2, 100]);
  });

  it('only slices when no cap is set', () => {
    const pool = byUser([1, 1, 1, 1]);

    expect(capPerUser(pool, 3)).toHaveLength(3);
    expect(capPerUser(pool, 3, 0)).toHaveLength(3);
  });

  it('never exceeds the visible slice', () => {
    const result = capPerUser(byUser([1, 2, 3, 4, 5, 6]), 3, 2);

    expect(result).toHaveLength(3);
  });
});
