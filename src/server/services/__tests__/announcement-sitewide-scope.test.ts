import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The sitewide announcement read is not a per-request query — it fills ONE global
// per-domain array that is then served to everybody. So an authored row reaching this
// query does not leak to one reader, it publishes one creator's announcement to the whole
// site. The filter therefore belongs on the cache fill, and this pins it there.
//
// Mock surface mirrors `announcement-media-window.test.ts`: the service builds redis keys
// at module scope, which is what forces the redis mock.

vi.mock('~/server/common/constants', () => ({ CacheTTL: { day: 86400 } }));
vi.mock('~/server/utils/pagination-helpers', () => ({
  DEFAULT_PAGE_SIZE: 20,
  getPagination: vi.fn(() => ({ take: 20, skip: 0 })),
  getPagingData: vi.fn((data) => data),
}));
vi.mock('~/shared/utils/prisma/enums', () => ({
  DomainColor: { all: 'all', green: 'green', red: 'red', blue: 'blue' },
}));

import { getAnnouncementsPaged, getCurrentAnnouncements } from '../announcement.service';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.announcement.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.announcement.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.announcement.count.mockResolvedValue(0 as never);
  dbMock.dbRead.$transaction.mockImplementation(async (ops: unknown) =>
    Promise.all(ops as Promise<unknown>[])
  );
});

describe('the global announcement cache carries platform rows only', () => {
  it('selects on a null author when filling the cache', async () => {
    await getCurrentAnnouncements({ domain: 'green' as never });

    const where = (
      dbMock.dbWrite.announcement.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }
    ).where;

    expect(where.userId).toBeNull();
    // Positive control: the domain predicate this query has always had is still applied,
    // so the assertion above is about an added filter rather than a query that stopped
    // filtering on anything.
    expect(where.domain).toBeDefined();
  });
});

describe('the moderator list is the sitewide tool', () => {
  it('scopes both the page and its count to platform rows', async () => {
    await getAnnouncementsPaged({ limit: 20, page: 1 } as never);

    const listWhere = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as { where: Record<string, unknown> }
    ).where;
    const countArgs = dbMock.dbRead.announcement.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };

    expect(listWhere.userId).toBeNull();
    // A count that forgot the filter would report creator rows in the total and page the
    // moderator into empty pages — same filter, both halves.
    expect(countArgs.where.userId).toBeNull();
  });
});
