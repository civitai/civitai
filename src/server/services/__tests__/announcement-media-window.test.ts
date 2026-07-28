import { describe, it, expect, vi, beforeEach } from 'vitest';

// The window predicate the announcement media health check reads. The read path and the
// monitor MUST agree about which announcements are showing, so both are built from one
// `announcementWindowOverlapsWhere`; the monitor only widens the upper bound so a broken
// banner is caught before it goes live rather than up to an hour after.
//
// Mock surface mirrors `announcement.memoize.test.ts` — the service's module-scope redis
// key construction is what forces the redis mock, nothing here touches the cache.
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('~/server/common/constants', () => ({ CacheTTL: { day: 86400 } }));
vi.mock('~/server/db/client', () => ({
  dbRead: { announcement: { findMany, count: vi.fn() }, $transaction: vi.fn() },
  dbWrite: { announcement: { findMany: vi.fn() } },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  REDIS_KEYS: { CACHES: { ANNOUNCEMENTS: 'packed:caches:announcements' } },
}));
vi.mock('~/server/utils/pagination-helpers', () => ({
  DEFAULT_PAGE_SIZE: 20,
  getPagination: vi.fn(),
  getPagingData: vi.fn(),
}));
vi.mock('~/shared/utils/prisma/enums', () => ({
  DomainColor: { all: 'all', green: 'green', red: 'red' },
}));

import {
  ANNOUNCEMENT_MEDIA_LOOKAHEAD_MS,
  activeAnnouncementWhere,
  announcementWindowOverlapsWhere,
  getMonitoredAnnouncementImageRefs,
} from '../announcement.service';

const NOW = new Date('2026-07-27T12:00:00.000Z');

/** Pull the `startsAt <= to` / `endsAt >= from` bounds out of the prisma where clause. */
function bounds(where: ReturnType<typeof announcementWindowOverlapsWhere>) {
  const and = where.AND as { OR: Record<string, { lte?: Date; gte?: Date }>[] }[];
  return {
    disabled: where.disabled,
    startsAtLte: and[0].OR[0].startsAt.lte,
    startsAtNullable: 'startsAt' in and[0].OR[1],
    endsAtGte: and[1].OR[0].endsAt.gte,
    endsAtNullable: 'endsAt' in and[1].OR[1],
  };
}

describe('announcement window predicate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('activeAnnouncementWhere is the degenerate from === to === now case', () => {
    // Structural equality, so the read path provably keeps its exact previous behaviour
    // after being refactored onto the shared builder.
    expect(activeAnnouncementWhere(NOW)).toEqual(announcementWindowOverlapsWhere(NOW, NOW));
  });

  it('only ever matches enabled announcements, and treats null dates as open-ended', () => {
    const b = bounds(activeAnnouncementWhere(NOW));
    expect(b.disabled).toBe(false);
    expect(b.startsAtNullable).toBe(true);
    expect(b.endsAtNullable).toBe(true);
  });

  it('widens only the upper bound — a banner ending today is still monitored', () => {
    // 🔴 The trap this pins: shifting the whole window forward (activeWhere(now + 24h))
    // would drop announcements that END within the next day, i.e. banners live RIGHT NOW.
    const to = new Date(NOW.getTime() + ANNOUNCEMENT_MEDIA_LOOKAHEAD_MS);
    const b = bounds(announcementWindowOverlapsWhere(NOW, to));

    expect(b.startsAtLte).toEqual(to);
    expect(b.endsAtGte).toEqual(NOW);
  });
});

describe('getMonitoredAnnouncementImageRefs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('queries live-now plus the look-ahead window', async () => {
    await getMonitoredAnnouncementImageRefs();

    const b = bounds(findMany.mock.calls[0][0].where);
    expect(b.endsAtGte).toEqual(NOW);
    expect(b.startsAtLte).toEqual(new Date(NOW.getTime() + ANNOUNCEMENT_MEDIA_LOOKAHEAD_MS));
  });

  it('defaults the look-ahead to a day and honours an explicit override', async () => {
    expect(ANNOUNCEMENT_MEDIA_LOOKAHEAD_MS).toBe(24 * 60 * 60 * 1000);

    await getMonitoredAnnouncementImageRefs(0);
    // A zero look-ahead collapses back to exactly the read path's "live now".
    expect(findMany.mock.calls[0][0].where).toEqual(activeAnnouncementWhere(NOW));
  });

  it('returns one ref per announcement carrying a banner key', async () => {
    findMany.mockResolvedValue([
      { id: 1, metadata: { image: 'key-a', colSpan: 6 } },
      { id: 2, metadata: { image: 'key-a' } },
      { id: 3, metadata: { image: 'key-b' } },
    ]);

    expect(await getMonitoredAnnouncementImageRefs()).toEqual([
      { id: 1, key: 'key-a' },
      { id: 2, key: 'key-a' },
      { id: 3, key: 'key-b' },
    ]);
  });

  it('drops announcements with no banner, null metadata or an empty key', async () => {
    findMany.mockResolvedValue([
      { id: 1, metadata: null },
      { id: 2, metadata: {} },
      { id: 3, metadata: { image: '' } },
      { id: 4, metadata: { image: 'key-a' } },
    ]);

    expect(await getMonitoredAnnouncementImageRefs()).toEqual([{ id: 4, key: 'key-a' }]);
  });

  it('returns an empty list rather than throwing when nothing is scheduled', async () => {
    findMany.mockResolvedValue([]);
    expect(await getMonitoredAnnouncementImageRefs()).toEqual([]);
  });
});
