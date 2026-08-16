import { describe, expect, it } from 'vitest';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';

// A key's wire value addresses live Redis entries written by deployed code, so a rename
// orphans whatever sits under the old name. These are the keys the services a-m tests used
// to hand-write next to their own client mocks, each with a value that disagreed with the
// real table; every one of those copies was fixture-only, so nothing in the suite would have
// noticed the divergence in either direction.

describe('redis key wire values', () => {
  it('pins the keys the services tests used to re-invent', () => {
    expect(REDIS_KEYS.CACHES.ANNOUNCEMENTS).toBe('packed:caches:announcement');
    expect(REDIS_SYS_KEYS.BLOCKS.EMERGENCY_KILL_LIST).toBe('system:blocks:emergency-kill-list');
    expect(REDIS_KEYS.CREATOR_PROGRAM).toEqual({
      CAPS: 'packed:caches:creator-program:caps',
      CASH: 'packed:caches:creator-program:cash',
      BANKED: 'packed:caches:creator-program:banked',
      PREV_MONTH_STATS: 'packed:caches:creator-program:prev-month-stats',
      POOL_VALUE: 'packed:caches:creator-program:pool-value',
      POOL_SIZE: 'packed:caches:creator-program:pool-size',
      POOL_FORECAST: 'packed:caches:creator-program:pool-forecast',
    });
    expect(REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES).toBe('creator-program:flip-phases');
  });
});
