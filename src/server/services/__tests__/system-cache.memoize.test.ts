import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the redis + db layers so we can assert how often the underlying redis
// GET actually fires for the memoized global blobs. Defined via vi.hoisted so
// the references are available inside the hoisted vi.mock factory below.
const { packedGet, packedSet } = vi.hoisted(() => ({
  packedGet: vi.fn(),
  packedSet: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: packedGet, set: packedSet },
    get: vi.fn(),
    set: vi.fn(),
  },
  sysRedis: { get: vi.fn(), set: vi.fn() },
  withSysReadDeadline: (p: Promise<unknown>) => p,
  REDIS_KEYS: { SYSTEM: { MODERATED_TAGS: 'system:moderated-tags' }, LIVE_NOW: 'live-now' },
  REDIS_SYS_KEYS: { SYSTEM: {}, CLIENT: 'client' },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { tag: { findMany: vi.fn() }, tagsOnTags: { findMany: vi.fn() } },
  dbWrite: { tag: { findMany: vi.fn() }, $queryRaw: vi.fn() },
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

import { getModeratedTags } from '../system-cache';

describe('system-cache in-proc memoize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getModeratedTags hits redis once, then serves subsequent calls from the in-proc memo', async () => {
    const blob = [{ id: 1, name: 'tag', nsfwLevel: 4 }];
    packedGet.mockResolvedValue(blob);

    const first = await getModeratedTags();
    const second = await getModeratedTags();
    const third = await getModeratedTags();

    expect(first).toEqual(blob);
    expect(second).toEqual(blob);
    expect(third).toEqual(blob);
    // Within the in-proc TTL all three calls collapse to a single redis GET.
    expect(packedGet).toHaveBeenCalledTimes(1);
  });
});
