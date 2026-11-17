import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// The status page shows when an announcement was last edited, so the served
// getCurrentAnnouncements response must carry `updatedAt` — through the DB select,
// the cache fill's map, and the redis JSON round-trip.
//
// The fake findMany honours `select`: it returns only the selected columns of each
// row, so a column the service forgets to select is missing here as it is in prod.

vi.mock('~/server/common/constants', () => ({ CacheTTL: { day: 86400 } }));
vi.mock('~/server/utils/pagination-helpers', () => ({
  DEFAULT_PAGE_SIZE: 20,
  getPagination: vi.fn(),
  getPagingData: vi.fn(),
}));
vi.mock('~/shared/utils/prisma/enums', () => ({
  DomainColor: { all: 'all', green: 'green', blue: 'blue', red: 'red' },
}));

const NOW = new Date('2026-11-01T06:00:00.000Z');
const UPDATED = new Date('2026-10-31T18:30:00.000Z');

const row = {
  id: 1,
  createdAt: new Date('2026-10-30T00:00:00.000Z'),
  updatedAt: UPDATED,
  startsAt: new Date('2026-10-30T00:00:00.000Z'),
  endsAt: null,
  title: 't',
  content: 'c',
  color: 'blue',
  emoji: null,
  metadata: {},
  targetUsers: [],
};

function project(select: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => key in row)
      .map((key) => [key, row[key as keyof typeof row]])
  );
}

const store = new Map<string, string>();

async function loadService() {
  vi.resetModules();
  return import('../announcement.service');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store.clear();
  dbMock.dbWrite.announcement.findMany.mockImplementation((async (args: {
    select: Record<string, unknown>;
  }) => [project(args.select)]) as never);
  redisMock.redis.get.mockImplementation((async (key: string) => store.get(key) ?? null) as never);
  redisMock.redis.set.mockImplementation((async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('getCurrentAnnouncements serves updatedAt', () => {
  it('when read back from the redis entry the database fill wrote', async () => {
    const first = await loadService();
    await first.getCurrentAnnouncements({ domain: 'blue' as never });
    expect(store.size).toBe(1);

    // A fresh module has an empty in-process memo, so this read comes from redis.
    const { getCurrentAnnouncements } = await loadService();
    const [announcement] = await getCurrentAnnouncements({ domain: 'blue' as never });
    expect(dbMock.dbWrite.announcement.findMany).toHaveBeenCalledTimes(1);
    expect(announcement).toHaveProperty('updatedAt');
    expect(new Date(announcement.updatedAt).toISOString()).toBe(UPDATED.toISOString());
  });
});
