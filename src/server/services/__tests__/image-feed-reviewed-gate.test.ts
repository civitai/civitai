import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as MeilisearchClient from '~/server/meilisearch/client';

const { queryWithTimeoutMock } = vi.hoisted(() => ({ queryWithTimeoutMock: vi.fn() }));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DbHelpers>();
  return { ...actual, queryWithTimeout: queryWithTimeoutMock };
});
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return { ...actual, metricsSearchClient: {}, getMetricsSearchClient: () => ({}) };
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

import { getAllImages, getImagesForModelVersion } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const REVIEWED = /"i"\."ingestion" = \S+ OR \( "i"\."nsfwLevelLocked" = TRUE/;
const squash = (sql: string) => sql.replace(/\s+/g, ' ');

async function getAllImagesSql(browsingLevel: number | undefined) {
  await getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    browsingLevel,
    include: [],
    user: { id: 1, isModerator: false },
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  return squash((queryWithTimeoutMock.mock.calls[0][2] as { text: string }).text);
}

async function modelVersionSql(browsingLevel: number | undefined) {
  let query: { strings: string[] } | undefined;
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (q: { strings: string[] }) => {
      query = q;
      return Promise.resolve([]);
    }
  );
  await getImagesForModelVersion({ modelVersionIds: [1], browsingLevel });
  expect(query, 'getImagesForModelVersion never issued its query').toBeDefined();
  return squash((query as { strings: string[] }).strings.join('?'));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe.each([
  ['getAllImages', getAllImagesSql],
  ['getImagesForModelVersion', modelVersionSql],
] as const)('%s gates on the reviewed predicate', (_name, sqlFor) => {
  it('with a browsing level', async () => {
    expect(await sqlFor(31)).toMatch(REVIEWED);
  });

  it('without a browsing level', async () => {
    expect(await sqlFor(undefined)).toMatch(REVIEWED);
  });
});
