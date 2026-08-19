import { describe, it, expect, vi } from 'vitest';
// STATIC import, same reasoning as get-models-raw.transient-503.test.ts: model.service
// is a ~4800-line module whose cold transform would otherwise be charged to the first
// test's timeout budget rather than to collection.
import { getModelsRaw } from '~/server/services/model.service';
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

// Same seams as the transient-503 test: break the event-engine-common import chain and
// no-op the blocked-tag enforcement that runs before the query is built.
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

async function sqlFor(input: Record<string, unknown>) {
  capturedQueries.length = 0;
  await getModelsRaw({ input: { browsingLevel: 1, take: 10, ...input } as never });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0].sql;
}

/**
 * The two PaidAccess gate kinds share one table and are told apart by `timeframeDays`,
 * NOT by `endsAt` (a timed gate carries a NULL `endsAt` until publish materializes it).
 * Getting that backwards is silent: the filter still returns rows, just the wrong ones.
 */
describe('getModelsRaw — paidAccess filter', () => {
  it('filters on the permanent-gate discriminator `timeframeDays IS NULL`', async () => {
    const sql = await sqlFor({ paidAccess: true });
    expect(sql).toContain('"timeframeDays" IS NULL');
  });

  it('does NOT reuse the early-access `endsAt > NOW()` predicate', async () => {
    const sql = await sqlFor({ paidAccess: true });
    expect(sql).not.toContain('"endsAt" > NOW()');
  });

  it('earlyAccess still filters on the timed-window predicate, not on timeframeDays', async () => {
    const sql = await sqlFor({ earlyAccess: true });
    expect(sql).toContain('"endsAt" > NOW()');
    expect(sql).not.toContain('"timeframeDays" IS NULL');
  });

  it('emits neither predicate when neither flag is set', async () => {
    const sql = await sqlFor({});
    expect(sql).not.toContain('"timeframeDays" IS NULL');
    expect(sql).not.toContain('"endsAt" > NOW()');
  });
});
