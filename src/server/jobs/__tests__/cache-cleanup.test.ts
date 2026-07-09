import { beforeEach, describe, expect, it, vi } from 'vitest';

// cache-cleanup.ts imports the real redis client + model.service modules, which
// open sockets / touch the DB at load. Mock them to in-memory fns whose hGetAll
// reply type (string vs Buffer values) we control per-test — that's the exact
// axis of the bug. mergeQueue is a spy so we can assert merge decisions. The
// mock fns are created via vi.hoisted so they exist before vi.mock's hoisted
// factory references them.
const { hGetAll, mergeQueue, refreshBlockedModelHashes } = vi.hoisted(() => ({
  hGetAll: vi.fn(),
  mergeQueue: vi.fn(() => Promise.resolve()),
  refreshBlockedModelHashes: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGetAll },
  REDIS_SYS_KEYS: { QUEUES: { BUCKETS: 'queues:buckets' } },
}));

vi.mock('~/server/redis/queues', () => ({
  mergeQueue,
}));

vi.mock('~/server/services/model.service', () => ({
  refreshBlockedModelHashes,
}));

// ./job imports db/client (Prisma) which reads env at module load and isn't set
// up in unit tests. We only need createJob's invoke contract: return an object
// whose .run() runs the handler and exposes the result promise.
vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: () => Promise<unknown>) => ({
    name: _name,
    cron: _cron,
    run: () => ({ result: fn(), cancel: () => Promise.resolve() }),
    options: {},
  }),
}));

import { cacheCleanup, shouldMergeBuckets } from '~/server/jobs/cache-cleanup';

beforeEach(() => {
  vi.clearAllMocks();
});

// Run the real createJob-wrapped job to completion.
async function runJob() {
  await cacheCleanup.run({}).result;
}

describe('cache-cleanup mergeQueue dispatch', () => {
  // Regression: the HA/Sentinel sysRedis client returns BLOB_STRING replies as a
  // Buffer. Under hGetAll the VALUES of the record are Buffers, so
  // `buckets.split(',')` threw `i?.split is not a function` and the hourly cron
  // 500'd every run → queue-merging stops → buckets accumulate. (Gap missed by
  // the #2697 queues.ts fix and the #2700 sweep.)
  it('does NOT throw and merges a multi-bucket Buffer value', async () => {
    hGetAll.mockResolvedValue({ 'images_v6:Update': Buffer.from('a,b', 'utf8') });
    await expect(runJob()).resolves.toBeUndefined();
    expect(mergeQueue).toHaveBeenCalledTimes(1);
    expect(mergeQueue).toHaveBeenCalledWith('images_v6:Update');
  });

  it('does NOT throw and SKIPS a single-bucket Buffer value (length === 1)', async () => {
    hGetAll.mockResolvedValue({ 'images_v6:Update': Buffer.from('a', 'utf8') });
    await expect(runJob()).resolves.toBeUndefined();
    expect(mergeQueue).not.toHaveBeenCalled();
  });

  it('merges a multi-bucket plain-string value (unchanged behavior)', async () => {
    hGetAll.mockResolvedValue({ 'images_v6:Update': 'a,b' });
    await runJob();
    expect(mergeQueue).toHaveBeenCalledTimes(1);
    expect(mergeQueue).toHaveBeenCalledWith('images_v6:Update');
  });

  it('skips a single-bucket plain-string value (unchanged behavior)', async () => {
    hGetAll.mockResolvedValue({ 'images_v6:Update': 'a' });
    await runJob();
    expect(mergeQueue).not.toHaveBeenCalled();
  });

  it('handles mixed Buffer + string values across multiple keys', async () => {
    hGetAll.mockResolvedValue({
      'images_v6:Update': Buffer.from('a,b,c', 'utf8'), // multi → merge
      'models_v9:Update': 'x', // single → skip
      'posts_v3:Update': 'p,q', // multi → merge
      'tags_v1:Update': Buffer.from('only', 'utf8'), // single → skip
    });
    await runJob();
    expect(mergeQueue).toHaveBeenCalledTimes(2);
    expect(mergeQueue).toHaveBeenCalledWith('images_v6:Update');
    expect(mergeQueue).toHaveBeenCalledWith('posts_v3:Update');
    expect(mergeQueue).not.toHaveBeenCalledWith('models_v9:Update');
    expect(mergeQueue).not.toHaveBeenCalledWith('tags_v1:Update');
  });

  it('still refreshes blocked-model hashes after merging', async () => {
    hGetAll.mockResolvedValue({});
    await runJob();
    expect(refreshBlockedModelHashes).toHaveBeenCalledTimes(1);
  });
});

describe('shouldMergeBuckets (extracted pure helper)', () => {
  it('Buffer multi-bucket → true', () => {
    expect(shouldMergeBuckets(Buffer.from('a,b', 'utf8'))).toBe(true);
  });
  it('Buffer single-bucket → false', () => {
    expect(shouldMergeBuckets(Buffer.from('a', 'utf8'))).toBe(false);
  });
  it('string multi-bucket → true', () => {
    expect(shouldMergeBuckets('a,b')).toBe(true);
  });
  it('string single-bucket → false', () => {
    expect(shouldMergeBuckets('a')).toBe(false);
  });
  it('empty string → false', () => {
    expect(shouldMergeBuckets('')).toBe(false);
  });
  it('empty Buffer → false', () => {
    expect(shouldMergeBuckets(Buffer.from('', 'utf8'))).toBe(false);
  });
  it('null / undefined → false', () => {
    expect(shouldMergeBuckets(null)).toBe(false);
    expect(shouldMergeBuckets(undefined)).toBe(false);
  });
});
