import { setEnv } from '~/__tests__/mocks/env.mock';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// deleteImages used to clear CollectionItem rows itself, one concurrent statement per image. Each
// deleted row fires collection_nsfw_level_change -> create_job_queue_record, an
// `INSERT ... ON CONFLICT DO NOTHING` on JobQueue's unique key, so two statements touching the same
// collection in opposite order deadlocked (40P01) on prod every run of remove-deleted-user-images.
// CollectionItem.imageId is `onDelete: Cascade`, so the DELETE below already removes those rows.

const { mockFindFirst, mockQueryRaw, mockCollectionItemDeleteMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockQueryRaw: vi.fn(async () => [] as unknown[]),
  mockCollectionItemDeleteMany: vi.fn(async () => ({ count: 0 })),
}));

function makePermissive(overrides: Record<string, unknown> = {}): any {
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop in overrides) return overrides[prop as string];
      if (!(prop in target)) target[prop as string] = makePermissive();
      return target[prop as string];
    },
    apply() {
      return Promise.resolve([]);
    },
  };
  // Callable target so the `apply` trap can fire; its body never runs.
  return new Proxy(function () {
    return undefined;
  }, handler);
}

const dbWrite = makePermissive({
  image: makePermissive({ findFirst: mockFindFirst }),
  collectionItem: makePermissive({ deleteMany: mockCollectionItemDeleteMany }),
  $queryRaw: mockQueryRaw,
});
const dbRead = makePermissive();

vi.mock('~/server/db/client', () => ({ dbRead, dbWrite }));

// event-engine-common is a git submodule, not checked out by default.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

beforeEach(() => {
  setEnv({
    DATABASE_IS_PROD: false,
  });
});

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: makePermissive({ insert: async () => undefined }),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: makePermissive({ packed: makePermissive() }),
    sysRedis: makePermissive(),
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
  };
});

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: vi.fn(async () => undefined),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));

const { deleteImages } = await import('../image.service');

describe('deleteImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves CollectionItem rows to the foreign key cascade', async () => {
    await deleteImages([1, 2, 3]);

    expect(mockCollectionItemDeleteMany).not.toHaveBeenCalled();
  });

  it('still deletes the image rows', async () => {
    await deleteImages([1, 2, 3]);

    const deletedImages = mockQueryRaw.mock.calls.some(([strings]) =>
      String((strings as unknown as string[])?.[0] ?? '').includes('DELETE FROM "Image"')
    );
    expect(deletedImages).toBe(true);
  });
});
