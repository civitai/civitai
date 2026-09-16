import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as Capture from '~/server/services/feed-request-capture.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

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
vi.mock('~/server/services/feed-request-capture.service', async (importOriginal) => {
  const actual = await importOriginal<typeof Capture>();
  return { ...actual, feedRequestCapture: () => ({ record: async () => undefined }) };
});

const queryRows = vi.fn((): unknown[] => []);
vi.mock('~/server/db/db-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DbHelpers>();
  return { ...actual, queryWithTimeout: async () => ({ rows: queryRows() }) };
});

import { getAllImages } from '../image.service';
import '~/__tests__/mocks/db.mock';

const byIds = (ids: number[]) =>
  ({
    sort: 'Newest',
    period: 'AllTime',
    periodMode: 'published',
    browsingLevel: 31,
    limit: ids.length,
    include: [],
    ids,
    user: { id: 42, isModerator: false },
  } as never);

const emptyLog = (stage: string) =>
  expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'images-by-ids-empty', stage, ids: 2 }),
    'civitai-prod'
  );

describe('pages requested by id that come back empty', () => {
  afterEach(() => {
    vi.useRealTimers();
    queryRows.mockReset();
  });

  it('names the query returning no rows', async () => {
    vi.setSystemTime(new Date('2026-09-16T10:00:00Z'));
    queryRows.mockReturnValue([]);
    const r = await getAllImages(byIds([4, 8]));
    expect(r.items).toEqual([]);
    emptyLog('no-rows');
  });

  it('names the viewer filter dropping every row', async () => {
    vi.setSystemTime(new Date('2026-09-16T11:00:00Z'));
    const row = (id: number) => ({
      id,
      userId: 7,
      postId: id,
      publishedAt: null,
      unpublishedAt: null,
      nsfwLevel: 1,
      type: 'image',
      url: `u${id}`,
      width: 1,
      height: 1,
      createdAt: new Date(),
      sortAt: new Date(),
      hideMeta: false,
      hasMeta: false,
      metadata: {},
    });
    queryRows.mockReturnValue([row(4), row(8)]);
    const r = await getAllImages(byIds([4, 8]));
    expect(r.items).toEqual([]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'images-by-ids-empty', stage: 'filtered', rows: 2 }),
      'civitai-prod'
    );
  });
});
