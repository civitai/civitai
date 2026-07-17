import { describe, it, expect, vi, beforeEach } from 'vitest';

// The announcement redis read (getAnnouncementsCached) is memoized per domain,
// while getCurrentAnnouncements applies the per-user (targetAudience) + active
// time-window filter AFTER, in JS. These tests prove the read collapses per
// domain and is user-INDEPENDENT (so the memo is safe). TTL expiry is covered
// in ttl-memoize.test.ts. Fresh module (fresh memos) per test via resetModules.
const { redisGet, redisSet } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('~/server/common/constants', () => ({ CacheTTL: { day: 86400 } }));
vi.mock('~/server/db/client', () => ({
  dbRead: { announcement: { findMany: vi.fn(), count: vi.fn() }, $transaction: vi.fn() },
  dbWrite: { announcement: { findMany: vi.fn() } },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { get: redisGet, set: redisSet, del: vi.fn() },
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
// ttl-memoize intentionally NOT mocked — the real memo is under test.

async function loadService() {
  vi.resetModules();
  return import('../announcement.service');
}

// A single always-active, audience-agnostic announcement so the downstream
// user/time filter keeps it for every caller.
function activeAnnouncement() {
  return [
    {
      id: 1,
      title: 't',
      content: 'c',
      color: 'blue',
      emoji: null,
      createdAt: new Date('2000-01-01').toISOString(),
      startsAt: new Date('2000-01-01').toISOString(),
      endsAt: new Date('2100-01-01').toISOString(),
      metadata: {},
    },
  ];
}

describe('announcement in-proc memoize (per domain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collapses the redis read across calls for the same domain, independent of userId', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockResolvedValue(JSON.stringify(activeAnnouncement()));

    const anon = await getCurrentAnnouncements({ domain: 'green' as never });
    const authed = await getCurrentAnnouncements({ userId: 42, domain: 'green' as never });

    // Both callers get the same (audience-agnostic) announcement...
    expect(anon).toHaveLength(1);
    expect(authed).toHaveLength(1);
    // ...from a SINGLE redis GET — the per-user filter runs outside the memo.
    expect(redisGet).toHaveBeenCalledTimes(1);
  });

  it('memoizes each domain independently (separate redis read per domain)', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockResolvedValue(JSON.stringify(activeAnnouncement()));

    await getCurrentAnnouncements({ domain: 'green' as never });
    await getCurrentAnnouncements({ domain: 'green' as never }); // collapsed
    await getCurrentAnnouncements({ domain: 'red' as never }); // separate slot
    await getCurrentAnnouncements({}); // no-domain default -> separate slot

    expect(redisGet).toHaveBeenCalledTimes(3);
  });

  it('fail-open: a rejected redis read is not cached and the next call retries', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockRejectedValueOnce(new Error('redis down'));

    await expect(getCurrentAnnouncements({ domain: 'green' as never })).rejects.toThrow(
      'redis down'
    );

    redisGet.mockResolvedValue(JSON.stringify(activeAnnouncement()));
    const recovered = await getCurrentAnnouncements({ domain: 'green' as never });
    expect(recovered).toHaveLength(1);
    expect(redisGet).toHaveBeenCalledTimes(2);
  });
});
