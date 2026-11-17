import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';

const { queryWithTimeoutMock } = vi.hoisted(() => ({ queryWithTimeoutMock: vi.fn() }));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DbHelpers>();
  return { ...actual, queryWithTimeout: queryWithTimeoutMock };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

import { getAllImages } from '../image.service';

const LEVEL_FILTER = /\(i\."nsfwLevel" & \$(\d+)\) != 0 AND i\."nsfwLevel" != 0/;

function run(browsingLevel: number | undefined) {
  return getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    modelId: 1,
    browsingLevel,
    include: [],
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
}

/** The level the gallery query filters on, read from the SQL it sends. */
async function queriedLevel(browsingLevel: number | undefined) {
  await run(browsingLevel);
  expect(queryWithTimeoutMock, 'the query was never sent').toHaveBeenCalled();
  const { text, values } = queryWithTimeoutMock.mock.calls[0][2] as {
    text: string;
    values: unknown[];
  };
  const param = text.replace(/\s+/g, ' ').match(LEVEL_FILTER)?.[1];
  expect(param, 'no browsing-level filter in the query').toBeDefined();
  return values[Number(param) - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe('getAllImages with a level of only unselectable bits', () => {
  it('answers Blocked alone (32) with an empty page, without querying', async () => {
    expect(await run(32)).toEqual({ items: [], nextCursor: undefined });
    expect(queryWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('[invariant] keeps the public fallback for an explicit 0 and for no level', async () => {
    expect(await queriedLevel(0)).toBe(1);
    vi.clearAllMocks();
    expect(await queriedLevel(undefined)).toBe(1);
  });

  it('[invariant] drops only the Blocked bit from a mixed mask (63 → 31)', async () => {
    expect(await queriedLevel(63)).toBe(31);
  });
});
