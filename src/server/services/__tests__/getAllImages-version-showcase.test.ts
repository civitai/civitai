/**
 * The model-page carousel and a creator's curated version showcase: when the version has a curated
 * list for the viewer's site, the carousel serves exactly those ids in that order, through the
 * cached-ids path, even with the flag that picks that path off for everyone else. Without one, the
 * carousel is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as FliptClient from '../../flipt/client';

// (Harness copied from getAllImages-prioritized-guards.test.ts.)
// getAllImages contains input-validation guards for the `prioritizeUser`
// (creator-first / model-showcase carousel) branch: it rejects `cursor` combined
// with `prioritizedUserIds`, and requires `modelVersionId` when the model-version
// cache path is taken. These are INVALID INPUT combinations (a client sending a
// load-more `cursor` while also asking for `prioritizedUserIds`), so they must
// surface as a tRPC BAD_REQUEST (400) — NOT a raw `Error` that the controller
// catch (`throwDbError`) turns into an INTERNAL_SERVER_ERROR (500). See the
// image.getInfinite raw-500 landmine (model-showcase carousel cursor +
// prioritizedUserIds, ~27 500s/12h).
//
// The mock block mirrors the established image.service unit-test recipe
// (image-metrics-timeout.test.ts): stub env + infra clients + the
// event-engine-common submodule so importing image.service boots no real infra.
// On top of that we stub `enforceBlockedBrowsingTags` (so the guard is reachable)
// and force `isFlipt` true so the model-version-cache branch (which holds both
// guards) is taken.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

// event-engine-common is a git submodule, not checked out by default — stub the
// value imports image.service pulls from it.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Fully replace env (importing the real `~/env/server` validates ALL prod env
// vars and throws in test). A Proxy returns safe values for anything read at
// module load.
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
// The guard sits after enforceBlockedBrowsingTags — stub it to a non-empty result
// so getAllImages proceeds into the prioritizeUser branch.
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

// The model-version-cache flag is OFF here: a curated showcase must take the cached-ids path on its
// own.
vi.mock('../../flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
});

const showcase = vi.hoisted(() => ({ ids: null as number[] | null, queries: [] as string[] }));
vi.mock('~/server/services/version-showcase.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCarouselShowcaseIds: vi.fn(async () => showcase.ids),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryCacheRaw: () => async (query: { text?: string; sql?: string; strings?: string[] }) => {
    showcase.queries.push(query.text ?? query.sql ?? (query.strings ?? []).join('?'));
    return [];
  },
}));

import { getAllImages } from '../image.service';

const input = {
  browsingLevel: 1,
  prioritizedUserIds: [123],
  modelVersionId: 456,
  include: [],
} as any;

describe('getAllImages: the carousel and a curated version showcase', () => {
  beforeEach(() => {
    showcase.queries = [];
  });

  it('serves the curated ids in their order, with the cache-branch flag off', async () => {
    showcase.ids = [30, 10, 20];
    await getAllImages(input);
    const sql = showcase.queries.at(-1) ?? '';
    expect(sql).toContain('array_position(ARRAY[30,10,20]::int[], i."id")');
    // The owner-only filter of the live branch must not apply: community images are someone else's.
    expect(sql).not.toMatch(/i\."userId" IN \(/);
  });

  it('keeps the live owner-first carousel when the version has no curated list', async () => {
    showcase.ids = null;
    await getAllImages(input);
    const sql = showcase.queries.at(-1) ?? '';
    expect(sql).not.toContain('array_position');
    expect(sql).toMatch(/i\."userId" IN \(/);
  });
});
