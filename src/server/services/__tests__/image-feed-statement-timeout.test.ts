import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as Blocked from '~/server/services/blocked-browsing-tags.service';

const { rawQuery, counterInc } = vi.hoisted(() => ({
  rawQuery: vi.fn(),
  counterInc: vi.fn(),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return {
    ...actual,
    registerCounter: () => ({ inc: vi.fn() }),
    registerCounterWithLabels: ((opts: { name: string }) =>
      opts.name === 'image_feed_statement_timeout_total'
        ? { inc: (labels: Record<string, string>) => counterInc(labels) }
        : actual.registerCounterWithLabels(
            opts as Parameters<typeof actual.registerCounterWithLabels>[0]
          )) as typeof actual.registerCounterWithLabels,
  };
});
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: (...args: unknown[]) => rawQuery(...args),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocked>()),
  enforceBlockedBrowsingTags: async () => ({ emptyResult: false }),
}));

import { getAllImages } from '../image.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const request = (extra: Record<string, unknown> = {}) =>
  ({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    browsingLevel: 1,
    include: [],
    user: { id: 1, isModerator: false },
    ...extra,
  } as unknown as Parameters<typeof getAllImages>[0]);

const timeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('getAllImages on a statement timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[invariant on the pre-change code] answers an empty page when the caller did not opt in', async () => {
    rawQuery.mockRejectedValue(timeout());
    expect(await getAllImages(request())).toEqual({ items: [], nextCursor: undefined });
    expect(rawQuery).toHaveBeenCalledTimes(1);
  });

  it('rethrows it for a caller that opts in, so a feed hydrate is not mistaken for an empty page', async () => {
    rawQuery.mockRejectedValue(timeout());
    await expect(getAllImages(request({ throwOnStatementTimeout: true }))).rejects.toMatchObject({
      code: '57014',
    });
    expect(rawQuery).toHaveBeenCalledTimes(1);
    // Still counted and logged before the rethrow.
    expect(counterInc).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'getInfiniteImages:statement_timeout' })
    );
  });

  it('[invariant on the pre-change code] still propagates a 57014 that is not a statement timeout', async () => {
    rawQuery.mockRejectedValue(
      Object.assign(new Error('canceling statement due to user request'), { code: '57014' })
    );
    await expect(getAllImages(request())).rejects.toMatchObject({ code: '57014' });
  });
});
