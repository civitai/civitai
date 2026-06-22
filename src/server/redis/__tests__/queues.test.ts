import { beforeEach, describe, expect, it, vi } from 'vitest';

// queues.ts imports the real redis client module, which opens sockets at load.
// Mock it to an in-memory sysRedis whose hGet reply type (string vs Buffer) we
// control per-test — that's the exact axis of the bug. The mock fns are created
// via vi.hoisted so they exist before vi.mock's hoisted factory references them.
const { hGet, hSet, sAdd, sMembers, del, exists } = vi.hoisted(() => ({
  hGet: vi.fn(),
  hSet: vi.fn(() => Promise.resolve(1)),
  sAdd: vi.fn(() => Promise.resolve(1)),
  sMembers: vi.fn(() => Promise.resolve([] as string[])),
  del: vi.fn(() => Promise.resolve(1)),
  exists: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet, hSet, sAdd, sMembers, del, exists },
  REDIS_SYS_KEYS: { QUEUES: { BUCKETS: 'queues:buckets' } },
  REDIS_SUB_KEYS: { QUEUES: { MERGING: 'merging' } },
}));

import { addToQueue, checkoutQueue } from '~/server/redis/queues';

// The bucket value is always persisted as a comma-joined string (see hSet calls
// in queues.ts). This is the exact value the failing prod path read back.
const BUCKETS_CSV = 'queues:buckets:images_v6:Update:1782075142958';

beforeEach(() => {
  vi.clearAllMocks();
  sMembers.mockResolvedValue([]);
});

describe('getBucketNames (via queues.ts public API)', () => {
  // Regression: the HA/Sentinel sysRedis client returns BLOB_STRING replies as a
  // Buffer. `currentBucket?.split(',')` then threw `i?.split is not a function`,
  // 500-ing every content-create mutation that enqueues a search-index update
  // (post.createWithImages / modelVersion.upsert / collection.saveItem). The
  // optional chain guarded null but NOT a wrong-typed Buffer.
  it('does NOT throw and parses bucket names when hGet returns a Buffer', async () => {
    hGet.mockResolvedValue(Buffer.from(BUCKETS_CSV, 'utf8'));

    // The pre-fix code threw synchronously inside this call.
    await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();

    // It read the existing bucket (did not mint+hSet a new one on the read-only path).
    expect(sMembers).toHaveBeenCalledWith(BUCKETS_CSV);
  });

  it('parses bucket names when hGet returns a plain string (unchanged behavior)', async () => {
    hGet.mockResolvedValue(BUCKETS_CSV);
    await expect(checkoutQueue('images_v6:Update', false, true)).resolves.toBeDefined();
    expect(sMembers).toHaveBeenCalledWith(BUCKETS_CSV);
  });

  it('treats a null hGet (empty queue) as no buckets — mints a fresh one on enqueue', async () => {
    hGet.mockResolvedValue(null);
    await addToQueue('images_v6:Update', [1, 2, 3]);
    // No existing bucket → a new bucket name is written, then ids are sAdd'd.
    expect(hSet).toHaveBeenCalledTimes(1);
    expect(sAdd).toHaveBeenCalledTimes(1);
  });

  it('handles a multi-bucket Buffer reply (comma-joined) without throwing', async () => {
    const csv = `${BUCKETS_CSV},queues:buckets:images_v6:Update:1782075150000`;
    hGet.mockResolvedValue(Buffer.from(csv, 'utf8'));
    await checkoutQueue('images_v6:Update', false, true);
    // Both buckets are read.
    expect(sMembers).toHaveBeenCalledWith(BUCKETS_CSV);
    expect(sMembers).toHaveBeenCalledWith('queues:buckets:images_v6:Update:1782075150000');
  });
});
