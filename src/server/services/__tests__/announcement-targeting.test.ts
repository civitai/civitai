import { describe, it, expect, vi, beforeEach } from 'vitest';

// Targeted announcements ride the same global per-domain cache flagged with
// `targeted: true`; getCurrentAnnouncements resolves per-user visibility with a
// single AnnouncementUser membership lookup — and only when a targeted
// announcement is actually live. These tests prove: non-members (and anon) never
// see a targeted announcement, members do, the internal `targeted` flag never
// leaks into the returned DTOs, and the membership query is skipped entirely
// when nothing is targeted.
const { redisGet, membershipFindMany, announcementCreate, userFindMany, createNotificationMock } =
  vi.hoisted(() => ({
    redisGet: vi.fn(),
    membershipFindMany: vi.fn(),
    announcementCreate: vi.fn(),
    userFindMany: vi.fn(),
    createNotificationMock: vi.fn(),
  }));

vi.mock('~/server/common/constants', () => ({ CacheTTL: { day: 86400 } }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: createNotificationMock,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    announcement: { findMany: vi.fn(), count: vi.fn() },
    announcementUser: { findMany: membershipFindMany },
    $transaction: vi.fn(),
  },
  dbWrite: {
    announcement: { findMany: vi.fn(), create: announcementCreate, update: vi.fn() },
    announcementUser: { deleteMany: vi.fn(), createMany: vi.fn() },
    user: { findMany: userFindMany },
    $transaction: vi.fn(),
  },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { get: redisGet, set: vi.fn(), del: vi.fn() },
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

async function loadService() {
  vi.resetModules();
  return import('../announcement.service');
}

function cachedAnnouncements() {
  const base = {
    title: 't',
    content: 'c',
    color: 'blue',
    emoji: null,
    createdAt: new Date('2000-01-01').toISOString(),
    startsAt: new Date('2000-01-01').toISOString(),
    endsAt: new Date('2100-01-01').toISOString(),
    metadata: {},
  };
  return [
    { ...base, id: 1, targeted: false },
    { ...base, id: 2, targeted: true },
  ];
}

describe('getCurrentAnnouncements targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides targeted announcements from anonymous users without a membership query', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockResolvedValue(JSON.stringify(cachedAnnouncements()));

    const result = await getCurrentAnnouncements({});

    expect(result.map((x) => x.id)).toEqual([1]);
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it('hides targeted announcements from non-members', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockResolvedValue(JSON.stringify(cachedAnnouncements()));
    membershipFindMany.mockResolvedValue([]);

    const result = await getCurrentAnnouncements({ userId: 42 });

    expect(result.map((x) => x.id)).toEqual([1]);
    expect(membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42, announcementId: { in: [2] } } })
    );
  });

  it('shows targeted announcements to members and strips the targeted flag', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockResolvedValue(JSON.stringify(cachedAnnouncements()));
    membershipFindMany.mockResolvedValue([{ announcementId: 2 }]);

    const result = await getCurrentAnnouncements({ userId: 42 });

    expect(result.map((x) => x.id)).toEqual([1, 2]);
    for (const announcement of result) {
      expect(announcement).not.toHaveProperty('targeted');
    }
  });

  it('skips the membership query when no live announcement is targeted', async () => {
    const { getCurrentAnnouncements } = await loadService();
    redisGet.mockResolvedValue(JSON.stringify(cachedAnnouncements().filter((x) => !x.targeted)));

    const result = await getCurrentAnnouncements({ userId: 42 });

    expect(result.map((x) => x.id)).toEqual([1]);
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it('treats pre-migration cache entries (no targeted field) as visible to everyone', async () => {
    const { getCurrentAnnouncements } = await loadService();
    const legacy = cachedAnnouncements().map(({ targeted, ...x }) => x);
    redisGet.mockResolvedValue(JSON.stringify(legacy));

    const result = await getCurrentAnnouncements({ userId: 42 });

    expect(result.map((x) => x.id)).toEqual([1, 2]);
    expect(membershipFindMany).not.toHaveBeenCalled();
  });
});

describe('upsertAnnouncement target notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    announcementCreate.mockResolvedValue({
      id: 7,
      title: 'Hello',
      metadata: { actions: [{ type: 'button', link: '/faq', linkText: 'FAQ' }] },
    });
  });

  it('notifies the target users with the announcement title and action url', async () => {
    const { upsertAnnouncement } = await loadService();
    userFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await upsertAnnouncement({
      title: 'Hello',
      content: 'c',
      targetUserIds: [1, 2, 2],
      notifyTargetedUsers: true,
    } as never);

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const arg = createNotificationMock.mock.calls[0][0];
    expect(arg.userIds).toEqual([1, 2]);
    expect(arg.type).toBe('system-announcement');
    expect(arg.details).toEqual({ message: 'Hello', url: '/faq' });
    expect(arg.key).toMatch(/^system-announcement:targeted:7:/);
  });

  it('does not notify without the flag', async () => {
    const { upsertAnnouncement } = await loadService();
    userFindMany.mockResolvedValue([{ id: 1 }]);

    await upsertAnnouncement({ title: 'Hello', content: 'c', targetUserIds: [1] } as never);

    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('rejects the whole save when target ids do not exist, naming them', async () => {
    const { upsertAnnouncement } = await loadService();
    userFindMany.mockResolvedValue([{ id: 1 }]);

    await expect(
      upsertAnnouncement({
        title: 'Hello',
        content: 'c',
        targetUserIds: [1, 999, 1000],
        notifyTargetedUsers: true,
      } as never)
    ).rejects.toThrow(/2 target user ids do not exist: 999, 1000/);

    expect(announcementCreate).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});
