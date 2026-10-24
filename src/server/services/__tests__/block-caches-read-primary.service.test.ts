import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';

// The block caches refill from the primary. The toggle commits a Block and then drops the
// cache field; a refill from a lagging replica would write "not blocked" back and, because
// the hash TTL is only set when absent, keep it until the hash expires.

const PRIMARY_ROWS = [{ id: 202, username: 'on-primary' }];
const REPLICA_ROWS = [{ id: 303, username: 'on-replica' }];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue(PRIMARY_ROWS);
  dbMock.dbRead.$queryRaw.mockResolvedValue(REPLICA_ROWS);
});

describe.each([
  ['BlockedByUsers', BlockedByUsers],
  ['BlockedUsers', BlockedUsers],
])('%s refill', (_name, cache) => {
  it('reads the primary, not the replica', async () => {
    await expect(cache.get({ userId: 101 })).resolves.toEqual(PRIMARY_ROWS);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
