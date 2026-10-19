import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getImagesFromSearchPreFilter` and `getImagesFromSearchPostFilter` are 506 of 672 lines
 * byte-identical, and PR #4148 hit what that costs: `publishedOnly` was honoured by the DB path and
 * ignored by BOTH builders, each carrying its own copy of the branch, so fixing one would silently
 * have left the other.
 *
 * 🔴 This does NOT assert the two build the same filter. They deliberately do not — the pre-filter
 * carries availability, blocked-resource and POI owner carve-outs the post-filter leaves to the
 * post-pass, and the two handle unscanned content differently. An equivalence test would either fail
 * on day one or force one of them to be wrong.
 *
 * What it asserts instead is the property that actually broke: a knob the caller can set has to
 * MOVE the filter in EVERY builder. A knob honoured in one and dropped in the other fails here,
 * named, without anyone having to notice the copies drifted.
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

const CURRENT_USER = 4321;

const baseInput = {
  currentUserId: CURRENT_USER,
  isModerator: false,
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 31,
  include: [] as string[],
  headers: { src: 'test' },
};

/**
 * Each knob, with a value that must change the filter.
 *
 * `base` carries anything the knob needs to be reachable — the three publication knobs only mean
 * anything to a moderator — and BOTH sides of the comparison get it, so the difference measured is
 * the knob and never the role that made it reachable.
 *
 * Not covered, deliberately: `hidden` and `followed` resolve their ids from Postgres and return
 * early when the lookup is empty, so they never reach the filter at all without a `dbRead` fake.
 * Their observable is that early return rather than a clause, which is a different property from
 * the one this file is about.
 */
const KNOBS: Array<{ name: string; base?: Record<string, unknown>; on: Record<string, unknown> }> =
  [
    { name: 'publishedOnly', base: { isModerator: true }, on: { publishedOnly: true } },
    { name: 'notPublished', base: { isModerator: true }, on: { notPublished: true } },
    { name: 'scheduled', base: { isModerator: true }, on: { scheduled: true } },
    { name: 'types', on: { types: ['video'] } },
    { name: 'withMeta', on: { withMeta: true } },
    { name: 'fromPlatform', on: { fromPlatform: true } },
    { name: 'baseModels', on: { baseModels: ['SDXL 1.0'] } },
    { name: 'tools', on: { tools: [7] } },
    { name: 'techniques', on: { techniques: [3] } },
    { name: 'modelVersionId', on: { modelVersionId: 12345 } },
    { name: 'postIds', on: { postIds: [777] } },
  ];

const BUILDERS = [
  ['getImagesFromSearchPreFilter', getImagesFromSearchPreFilter],
  ['getImagesFromSearchPostFilter', getImagesFromSearchPostFilter],
] as const;

type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];

describe.each(BUILDERS)('%s honours every caller knob', (_name, fn) => {
  /**
   * The filter the builder handed Meili, with timestamps blanked. `snapToInterval(Date.now())` puts a
   * clock-derived number in the publication clause, so two calls either side of an interval boundary
   * differ for a reason that has nothing to do with the knob under test.
   */
  const filterFor = async (input: Record<string, unknown>) => {
    vi.clearAllMocks();
    fetchDocumentsAbortableMock.mockRejectedValue(new Error('stop here'));

    await expect(fn(input as unknown as SearchArg)).rejects.toThrow('stop here');
    expect(fetchDocumentsAbortableMock).toHaveBeenCalledTimes(1);

    const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
    return String((request as { filter: string }).filter).replace(/\d{10,}/g, '<ts>');
  };

  // Without this the comparisons below are meaningless: if the filter varied on its own, every knob
  // would "move" it and the whole suite would pass against a builder that reads none of them.
  it('builds a stable filter for a stable input', async () => {
    expect(await filterFor(baseInput)).toBe(await filterFor(baseInput));
  });

  it.each(KNOBS.map((k) => [k.name, k.base ?? {}, k.on] as const))(
    '%s changes the filter',
    async (_knob, base, on) => {
      const off = await filterFor({ ...baseInput, ...base });
      const withKnob = await filterFor({ ...baseInput, ...base, ...on });

      expect(withKnob, `the filter is identical with and without it:\n${off}`).not.toBe(off);
    }
  );
});
