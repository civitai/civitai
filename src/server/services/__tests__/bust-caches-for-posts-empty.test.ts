import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// deleteImages deletes the Image rows first (RETURNING), busts caches in a Promise.all, then
// deletes the S3 objects. A batch whose images all have `postId IS NULL` yields an empty id list,
// and `Prisma.join([])` throws — so the throw lands after the rows are gone and before the S3
// stage, leaving objects publicly reachable on unsigned CDN urls with nothing left to find them by.
//
// post.service is the graph root; the mock scaffold mirrors the established recipe
// (delete-image-from-s3-logging.test.ts): stub env + infra clients so importing it boots no
// real infra. `Prisma` itself is deliberately NOT mocked — the throw under test is real.

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

const mockQueryRaw = dbMock.dbWrite.$queryRaw;

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: makePermissive({ insert: async () => undefined }),
}));

const { bustCachesForPosts } = await import('../post.service');

describe('bustCachesForPosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns without querying when the id list is empty', async () => {
    await expect(bustCachesForPosts([])).resolves.toBeUndefined();

    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('still queries when given ids', async () => {
    await bustCachesForPosts([123]);

    expect(mockQueryRaw).toHaveBeenCalled();
  });
});
