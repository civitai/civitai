import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

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
// (image-metrics-timeout.test.ts): stub env + infra clients + the private
// event-engine-common submodule so importing image.service boots no real infra.
// On top of that we stub `enforceBlockedBrowsingTags` (so the guard is reachable)
// and force `isFlipt` true so the model-version-cache branch (which holds both
// guards) is taken.

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

// event-engine-common is a private git submodule not checked out in this
// worktree — stub the value imports image.service pulls from it.
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

// Stub the infra clients so no real DB/Redis connection is opened on import.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

// The guard sits after enforceBlockedBrowsingTags — stub it to a non-empty result
// so getAllImages proceeds into the prioritizeUser branch.
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

// Force the Flipt model-version-cache flag ON so `useModelVersionCache` is true
// and the branch containing BOTH guards is taken. Keep every other flipt export
// real (FLIPT_FEATURE_FLAGS etc. are used at module load).
vi.mock('../../flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../flipt/client')>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(true) };
});

import { getAllImages } from '../image.service';

const baseInput = {
  browsingLevel: 1,
  prioritizedUserIds: [123],
  include: [], // controller always forwards an include array
} as any;

describe('getAllImages prioritizedUserIds input guards → BAD_REQUEST (not 500)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects cursor + prioritizedUserIds with a BAD_REQUEST TRPCError (not INTERNAL_SERVER_ERROR)', async () => {
    let caught: unknown;
    try {
      await getAllImages({ ...baseInput, modelVersionId: 456, cursor: 999 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
    expect((caught as TRPCError).code).not.toBe('INTERNAL_SERVER_ERROR');
    expect((caught as TRPCError).message).toBe('Cannot use cursor with prioritizedUserIds');
  });

  it('rejects prioritizedUserIds without modelVersionId with a BAD_REQUEST TRPCError', async () => {
    let caught: unknown;
    try {
      await getAllImages({ ...baseInput }); // no cursor, no modelVersionId
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
    expect((caught as TRPCError).message).toBe(
      'modelVersionId is required when using prioritizedUserIds'
    );
  });
});
