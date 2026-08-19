import { beforeEach, describe, expect, it, vi } from 'vitest';

// `source` is what the BitDex feed notice keys on: it must name the backend that
// ACTUALLY served the page, not the flag variant. Two ways that diverges:
//   - shadow runs BitDex in the background and serves Meili → must report meili
//   - primary falls through to Meili when BitDex errors → must report meili
// Getting either wrong puts a "we're testing a new system" notice over old-system
// results, so the feedback would describe the wrong backend.
//
// Same minimal-seam mocking as image-feed-clickhouse-failsoft.test.ts: stub the
// event-engine-common submodule + infra clients + env so importing image.service
// doesn't boot real infra.

import type * as BitdexClient from '~/server/bitdex/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';

const { queryBitdexMock, getFliptVariantMock } = vi.hoisted(() => ({
  queryBitdexMock: vi.fn(),
  getFliptVariantMock: vi.fn(),
}));

vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    populatedQuery = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
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

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
// `metricsSearchClient: null` makes getImagesFromSearchPreFilter return an empty
// page immediately — the Meili leg still RUNS and still stamps source 'meili',
// which is the whole point, without needing a live index.
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  metricsSearchClient: null,
}));

vi.mock('~/server/bitdex/client', async (importOriginal) => ({
  ...(await importOriginal<typeof BitdexClient>()),
  queryBitdex: queryBitdexMock,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: getFliptVariantMock,
  getFliptBoolean: vi.fn().mockResolvedValue(false),
}));

import { getImagesFromSearch } from '../image.service';
import {
  BITDEX_SERVE_MODES,
  BITDEX_SERVE_OUTCOMES,
  ensureRegisterBitdexFeedServeMetrics,
  type BitdexServeMode,
  type BitdexServeOutcome,
} from '~/server/metrics/bitdex-feed-serve.metrics';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

const bitdexDoc = {
  id: 101,
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: 7,
  type: 'image',
  availability: 'Public',
  postId: 55,
  postedToId: null,
  hasMeta: true,
  onSite: true,
  poi: false,
  minor: false,
  width: 100,
  height: 100,
  reactionCount: 0,
  commentCount: 0,
  collectedCount: 0,
  sortAt: 1_700_000_000,
  publishedAt: 1_700_000_000,
};

// `cursor: undefined` terminates fetchBitdexPrimary's pass loop on the first
// iteration. A fake that always returned a cursor would spin to MAX_PASSES.
const bitdexPage = { documents: [bitdexDoc], cursor: undefined };

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  periodMode: 'published',
  include: [],
  currentUserId: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
} as any;

describe('getImagesFromSearch — reported source names the backend that served the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryBitdexMock.mockResolvedValue(bitdexPage);
  });

  it('reports meili in SHADOW mode even though BitDex ran and returned documents', async () => {
    getFliptVariantMock.mockResolvedValue('shadow');

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });

  it('reports bitdex in PRIMARY mode when BitDex serves the page', async () => {
    getFliptVariantMock.mockResolvedValue('primary');

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
  });

  it('reports meili in PRIMARY mode when BitDex throws and Meili serves the fallback', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockRejectedValue(new Error('bitdex is down'));

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });
});

/**
 * 🔴 POSITIVE CONTROL FOR `bitdex_primary_result_total` (#3930).
 *
 * The whole value of this counter is that a ZERO on `outcome="fallback_error"`
 * can be believed. A counter that is never incremented reads zero too, and the
 * two are indistinguishable from a dashboard — so a zero is worthless until
 * something has been watched to move.
 *
 * Every case below asserts on the DELTA and asserts that EXACTLY ONE series
 * moved, naming which. Two properties fall out of that shape:
 *   - an emit line deleted anywhere makes the corresponding case fail on the
 *     COUNTER's assertion (0 series moved), not on the `source` assertion in the
 *     sibling describe above — the pre-existing assertion would still pass, and
 *     a green-for-the-wrong-reason is exactly what this control has to exclude;
 *   - the labels cannot be swapped, transposed, or collapsed onto one series
 *     without a different case going red, because a different one is named in
 *     each.
 *
 * 🔴 On the "BitDex throws" arm in the describe above: it drives a path
 * PRODUCTION CANNOT REACH. `queryBitdex` documents that it never throws and
 * returns `null` on every failure, so the mock replacing it with a rejection is
 * exercising the application-error arm (`fallback_exception`), not a BitDex
 * outage. The reachable version of a BitDex outage is a `null` return WITH the
 * failure callback invoked, which is what the `fallback_error` case below
 * drives — through the collector, the way the client actually reports it.
 */
type OutcomeSnapshot = Record<string, number>;

async function readOutcomes(): Promise<OutcomeSnapshot> {
  const { primaryResultTotal } = ensureRegisterBitdexFeedServeMetrics();
  const { values } = await (
    primaryResultTotal as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    }
  ).get();
  // Every combination pre-populated at 0, derived from the unions rather than
  // listed: a series that is absent and a series that is zero must compare
  // equal here, or the delta below would report "moved" for a first-ever emit
  // on some other test's behalf.
  const snapshot: OutcomeSnapshot = {};
  for (const outcome of BITDEX_SERVE_OUTCOMES)
    for (const mode of BITDEX_SERVE_MODES) snapshot[`${outcome}|${mode}`] = 0;
  for (const v of values) snapshot[`${v.labels.outcome}|${v.labels.mode}`] = v.value;
  return snapshot;
}

function seriesThatMoved(before: OutcomeSnapshot, after: OutcomeSnapshot): string[] {
  return Object.keys(after)
    .filter((key) => (after[key] ?? 0) !== (before[key] ?? 0))
    .sort();
}

const key = (outcome: BitdexServeOutcome, mode: BitdexServeMode) => `${outcome}|${mode}`;

describe('bitdex_primary_result_total moves, and moves a DIFFERENT series per outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryBitdexMock.mockResolvedValue(bitdexPage);
  });

  it('PRIMARY, BitDex answers with documents → served{mode="primary"} +1, and nothing else', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('bitdex');
    expect(seriesThatMoved(before, after)).toEqual([key('served', 'primary')]);
    expect(after[key('served', 'primary')] - before[key('served', 'primary')]).toBe(1);
  });

  it('PRIMARY, every call SUCCEEDS but the index has nothing → fallback_empty{mode="primary"} +1', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    // A successful, genuinely empty page: no failure callback is invoked.
    queryBitdexMock.mockResolvedValue({ documents: [], cursor: undefined });
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_empty', 'primary')]);
  });

  it('🔴 PRIMARY, a call FAILS and the result is empty → fallback_error{mode="primary"} +1, NOT fallback_empty', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    // The reachable shape of a BitDex outage: the client returns `null` — it
    // never throws — and reports the classification through the callback it was
    // handed. Driven through the collector rather than asserted on the mock, so
    // this fails if the service stops passing the callback down.
    queryBitdexMock.mockImplementation(async (...args: unknown[]) => {
      const onFailure = args.find((a) => typeof a === 'function') as
        | ((reason: string) => void)
        | undefined;
      onFailure?.('http_5xx');
      return null;
    });
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_error', 'primary')]);
  });

  it('PRIMARY, the application itself throws → fallback_exception{mode="primary"} +1', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockRejectedValue(new Error('bitdex is down'));
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_exception', 'primary')]);
  });

  it('SHADOW, BitDex answers with documents → served{mode="shadow"} +1 (Meili still serves the user)', async () => {
    getFliptVariantMock.mockResolvedValue('shadow');
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);
    expect(result.source).toBe('meili');

    // Shadow work is deliberately detached and outlives the user-facing return,
    // so the emit lands after the awaited call resolves. Waiting is the only
    // honest read; a bare read here would be a race that passes by luck.
    await vi.waitFor(async () => {
      const after = await readOutcomes();
      expect(seriesThatMoved(before, after)).toEqual([key('served', 'shadow')]);
    });
  });
});
