import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PromClient from '~/server/prom/client';
import type * as FliptClient from '~/server/flipt/client';

// Pinning is per model version, so a pinned post must contribute only the media that version made.
// The carve-out for media carrying no resource rows is the whole point of the function and is what a
// naive "just filter on the resource row" rewrite drops -- which is how pinned posts with videos
// vanished from model galleries. A post left with nothing is meant to drop out.
//
// Mock recipe follows image-hide-challenges-exclusion.test.ts: stub env + infra clients + the
// event-engine-common submodule so importing image.service boots no real infra.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

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

// `getResourceIdsForImages` picks its client at call time —
// `const db = useWrite ? dbWrite : dbRead` — off the IMAGE_RESOURCE_USE_WRITE flag, and the
// flipt mock below pins that flag to false. So the read here lands on the REPLICA, and naming
// the replica is what makes a route change visible: the old fixture aliased both clients to
// one spy, which would have absorbed the flag flipping either way.
const queryRaw = dbMock.dbRead.$queryRaw;

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

vi.mock('../../flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
  getFliptBoolean: vi.fn().mockResolvedValue(false),
  getFliptVariant: vi.fn().mockResolvedValue(null),
}));

import { filterPinnedImagesToVersion } from '../image.service';

const PINNED_VERSION = 280515;
const OTHER_VERSION = 274522;

type Row = { imageId: number; modelVersionId: number };
const image = (id: number, postId: number) => ({ id, postId });
const resourceRows = (...rows: [number, number][]): Row[] =>
  rows.map(([imageId, modelVersionId]) => ({ imageId, modelVersionId }));

describe('filterPinnedImagesToVersion', () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it('drops images in a pinned post that were made with a different version', async () => {
    queryRaw.mockResolvedValue(
      resourceRows([1, PINNED_VERSION], [2, OTHER_VERSION], [3, OTHER_VERSION])
    );

    const result = await filterPinnedImagesToVersion(
      [image(1, 900), image(2, 900), image(3, 900)],
      PINNED_VERSION
    );

    expect(result.map((x) => x.id)).toEqual([1]);
  });

  it('keeps media that has no resource rows at all', async () => {
    // The video case: resource detection never wrote a row, so the media can't be attributed
    // either way. Dropping it is what made pinned posts with videos disappear.
    queryRaw.mockResolvedValue(resourceRows([1, PINNED_VERSION], [2, OTHER_VERSION]));

    const result = await filterPinnedImagesToVersion(
      [image(1, 900), image(2, 900), image(3, 900)],
      PINNED_VERSION
    );

    expect(result.map((x) => x.id)).toEqual([1, 3]);
  });

  it('drops a pinned post entirely when every image in it belongs to another version', async () => {
    // The post can only reappear here by being unpinned-and-repinned or re-attributed. Keeping it
    // whole instead would put images the version never made back on the gallery, which is the bug.
    queryRaw.mockResolvedValue(resourceRows([1, OTHER_VERSION], [2, OTHER_VERSION]));

    const result = await filterPinnedImagesToVersion(
      [image(1, 900), image(2, 900)],
      PINNED_VERSION
    );

    expect(result).toEqual([]);
  });

  it('applies the same rule across posts in one batch', async () => {
    queryRaw.mockResolvedValue(
      resourceRows([1, PINNED_VERSION], [2, OTHER_VERSION], [3, OTHER_VERSION])
    );

    const result = await filterPinnedImagesToVersion(
      [image(1, 900), image(2, 900), image(3, 901), image(4, 901)],
      PINNED_VERSION
    );

    // Post 900 narrows to its match; post 901 keeps only image 4, which carries no rows at all.
    expect(result.map((x) => x.id)).toEqual([1, 4]);
  });

  it('keeps an image carrying rows for both the pinned version and others', async () => {
    queryRaw.mockResolvedValue(resourceRows([1, OTHER_VERSION], [1, PINNED_VERSION]));

    const result = await filterPinnedImagesToVersion([image(1, 900)], PINNED_VERSION);

    expect(result.map((x) => x.id)).toEqual([1]);
  });

  it('does not query when there is nothing to filter', async () => {
    const result = await filterPinnedImagesToVersion([], PINNED_VERSION);

    expect(result).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
