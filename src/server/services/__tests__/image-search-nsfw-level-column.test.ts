import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The green (SFW) domain used to filter feeds on `combinedNsfwLevel`
 * (`nsfwLevelLocked ? nsfwLevel : max(nsfwLevel, aiNsfwLevel)`) while every other
 * domain filtered `nsfwLevel` — the number the card badge renders. `aiNsfwLevel` was
 * written by the image-scan webhook's `aiRating`, which stopped arriving mid-2025
 * (0% of images since July), so the column froze and the gate only suppressed a 2024
 * band: ~1.3M images carrying an SFW badge, invisible on civitai.com, scored by a
 * scanner that no longer runs — including, in a prod sample, a kitten rated XXX.
 *
 * Asserted on the filter string handed to Meili rather than on returned rows, because
 * that string IS the behaviour: rows come from a fake and could not tell the right
 * column from the wrong one. Preamble mirrors `image-search-published-only.test.ts`.
 * (ClickUp 868m65e51)
 */

import type * as MeilisearchClient from '~/server/meilisearch/client';

const { fetchDocumentsAbortableMock } = vi.hoisted(() => ({
  fetchDocumentsAbortableMock: vi.fn(),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return {
    ...actual,
    metricsSearchClient: {},
    getMetricsSearchClient: () => ({}),
    fetchDocumentsAbortable: fetchDocumentsAbortableMock,
  };
});

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

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { getImagesFromSearchPreFilter, getImagesFromSearchPostFilter } from '../image.service';
import { imagesFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { filterableAttributes as metricsImagesFilterableAttributes } from '~/server/search-index/metrics-images.search-index';

// A viewer with no NSFW access on a PG-capped domain: the exact request that used to
// be served from the other column.
const sfwViewerInput = {
  currentUserId: 99,
  isModerator: false,
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 1,
  include: [] as string[],
  headers: { src: 'test' },
};

describe.each([
  ['getImagesFromSearchPreFilter', getImagesFromSearchPreFilter],
  ['getImagesFromSearchPostFilter', getImagesFromSearchPostFilter],
])('%s filters the rated level, not the AI score', (_name, fn) => {
  type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    // Thrown so the test stops at the seam it is about; the filter is fully formed
    // on the recorded arguments before the call.
    fetchDocumentsAbortableMock.mockRejectedValue(new Error('stop here'));
  });

  const filterFor = async (input: Record<string, unknown>) => {
    await expect(fn(input as unknown as SearchArg)).rejects.toThrow('stop here');
    expect(fetchDocumentsAbortableMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
    return String((request as { filter: string }).filter);
  };

  it('names nsfwLevel in the browsing-level clause', async () => {
    const filter = await filterFor(sfwViewerInput);

    // Positive control: without it, the assertion below passes against a build that
    // emits no level clause at all, which would be a far worse bug than the one fixed.
    expect(filter, `no nsfwLevel clause in: ${filter}`).toMatch(/\bnsfwLevel IN \[/);
    expect(filter).not.toContain('combinedNsfwLevel');
  });
});

// Meili rejects a filter naming an attribute that is not filterable, so removing it
// here is what turns a re-introduced `combinedNsfwLevel` filter into a loud failure
// instead of a silent empty page.
describe('combinedNsfwLevel is retired from the image indexes', () => {
  it.each([
    ['images', imagesFilterableAttributes],
    ['metrics images', metricsImagesFilterableAttributes],
  ])('%s index does not offer it as a filterable attribute', (_name, attributes) => {
    expect(attributes).toContain('nsfwLevel');
    expect(attributes).not.toContain('combinedNsfwLevel');
  });
});
