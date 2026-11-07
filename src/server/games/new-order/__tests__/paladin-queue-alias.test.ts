// Every rank a player can hold must resolve to a queue.
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(), zAddWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: vi.fn() }));

import { legacyRank, poolCounters, poolKeys } from '~/server/games/new-order/utils';

describe('legacyRank', () => {
  it('maps Paladin to Templar and leaves every other rank alone', () => {
    expect(legacyRank('Paladin')).toBe('Templar');
    expect(legacyRank('Templar')).toBe('Templar');
    expect(legacyRank('Knight')).toBe('Knight');
    expect(legacyRank('Acolyte')).toBe('Acolyte');
  });

  it('always has pools for the mapped rank', () => {
    for (const rank of ['Acolyte', 'Knight', 'Templar', 'Paladin'] as const) {
      expect(poolKeys[legacyRank(rank)].a.length).toBeGreaterThan(0);
      expect(poolCounters[legacyRank(rank)].a.length).toBeGreaterThan(0);
    }
  });
});
