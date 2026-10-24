import { describe, it, expect, vi, beforeEach } from 'vitest';
// STATIC import, same reasoning as get-models-raw.paid-access-filter.test.ts: model.service
// is a ~4800-line module whose cold transform would otherwise be charged to the first
// test's timeout budget rather than to collection.
import { getModels, getModelsRaw } from '~/server/services/model.service';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({ capturedQueries: [] as { sql: string }[] }));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { sql: string }) => {
      capturedQueries.push(query);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

// Same seams as the paid-access filter test: break the event-engine-common import chain
// and no-op the blocked-tag enforcement that runs before either query is built.
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

/** What the REST endpoint hands the services: `req.query`, so a STRING. */
function fromQueryString(earlyAccess: string) {
  const { cursor, ...input } = getAllModelsSchema.parse({ earlyAccess, browsingLevel: 1 });
  return input;
}

/**
 * The parse is only half the bug. Both consumers read the parsed value with a bare
 * truthy check, so this pins that each one actually stops emitting its filter — asserted
 * against the query, not reasoned from the parsed value.
 */
describe('?earlyAccess=false reaches the raw SQL consumer as OFF', () => {
  beforeEach(() => {
    capturedQueries.length = 0;
  });

  it('emits no early-access predicate for the string `false`', async () => {
    await getModelsRaw({ input: { ...fromQueryString('false'), take: 10 } as never });
    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries[0].sql).not.toContain('"endsAt" > NOW()');
  });

  // Positive control: without it the assertion above passes just as happily against a
  // build that never emits the predicate at all.
  it('still emits it for the string `true`', async () => {
    await getModelsRaw({ input: { ...fromQueryString('true'), take: 10 } as never });
    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries[0].sql).toContain('"endsAt" > NOW()');
  });
});

describe('?earlyAccess=false reaches the Prisma consumer as OFF', () => {
  async function whereFor(earlyAccess: string) {
    // `resetSharedMocks()` runs per FILE, not per test, so without this the assertions
    // below can read the previous test's call and pass on stale state.
    dbMock.dbRead.model.findMany.mockClear();
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ modelId: 123 }]);
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    await getModels({
      input: { ...fromQueryString(earlyAccess), take: 10 } as never,
      select: { id: true },
    });
    // Pin the call itself. Without this, an early return inside getModels leaves `where`
    // undefined, the stringified `[]` contains no '123', and the negative test passes for
    // entirely the wrong reason.
    expect(dbMock.dbRead.model.findMany).toHaveBeenCalledTimes(1);
    const call = dbMock.dbRead.model.findMany.mock.calls.at(-1);
    return (call?.[0] as { where?: { AND?: unknown[] } } | undefined)?.where;
  }

  it('adds no early-access id restriction for the string `false`', async () => {
    const where = await whereFor('false');
    expect(JSON.stringify(where?.AND ?? [])).not.toContain('123');
  });

  it('still adds it for the string `true`', async () => {
    const where = await whereFor('true');
    expect(JSON.stringify(where?.AND ?? [])).toContain('123');
  });
});
