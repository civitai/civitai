import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cross-request isolation for the moderation flags on a cached generation resource.
 *
 * `getResourceData` strips `model.sfwOnly` / `model.minor` from a resource the requesting user
 * cannot generate with. `canGenerate` is a PER-USER decision (ownership, moderator status,
 * per-user gates), so two concurrent callers can legitimately disagree about it.
 *
 * The record those flags hang off comes from the shared per-id resource cache. That cache clones a
 * record only at the TOP level, so on its fail-open path — where one origin lookup is single-flighted
 * and its result handed to every caller that joined the window — the nested `model` object is ONE
 * object shared by all of them. Removing a field from it in place therefore applies one user's gate
 * decision to another user's payload.
 *
 * Nothing here hand-constructs the sharing. A rejecting cache read forces the real fail-open path, a
 * gated origin query holds the real lookup open so a second caller joins the same in-flight promise,
 * and the assertions read what the real `getResourceData` returns.
 */

const mGetMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
const setNxMock = vi.fn().mockResolvedValue(true);
const delMock = vi.fn().mockResolvedValue(undefined);

vi.mock('~/server/redis/client', () => {
  const sysKeyProxy: any = new Proxy(() => 'sys', { get: () => sysKeyProxy });
  return {
    redis: {
      packed: {
        mGet: (...args: unknown[]) => mGetMock(...args),
        set: (...args: unknown[]) => setMock(...args),
        get: vi.fn(),
      },
      setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
      del: (...args: unknown[]) => delMock(...args),
      get: vi.fn(),
      set: vi.fn(),
    },
    // getGateRules reads this; null => no gate rules configured.
    sysRedis: { hGet: vi.fn().mockResolvedValue(null), hSet: vi.fn() },
    REDIS_KEYS: {
      CACHE_LOCKS: 'caches:lock',
      GENERATION: { RESOURCE_DATA: 'packed:generation:resource-data-3' },
    },
    REDIS_SYS_KEYS: sysKeyProxy,
    REDIS_SUB_KEYS: sysKeyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});

const { degradedInc, originFetchInc } = vi.hoisted(() => ({
  degradedInc: vi.fn(),
  originFetchInc: vi.fn(),
}));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: degradedInc },
  cacheFailOpenOriginFetchCounter: { inc: originFetchInc },
}));

// The origin for the REAL resourceDataCache lookupFn (a raw query in resource-data.redis).
const { queryRawMock } = vi.hoisted(() => ({ queryRawMock: vi.fn() }));
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: queryRawMock },
  dbWrite: { $queryRaw: queryRawMock },
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/orchestrator/ecosystems/wan.handler', () => ({
  wanBaseModelGroupIdMap: {},
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  // Only reached for resources needing substitutes; returns no candidate versions.
  getDbWithoutLagBatch: vi.fn(async () => ({
    modelVersion: { findMany: vi.fn(async () => []) },
  })),
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/paid-access-gating', () => ({
  applyPaidAccessGating: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(async () => new Map()),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { GENERATION_TESTING: 'generation-testing' },
  isFlipt: vi.fn(async () => false),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { getResourceData } from '~/server/services/generation/generation.service';
import { resourceDataCache } from '~/server/redis/resource-data.redis';

const VERSION_ID = 4242;
const REDIS_TIMEOUT = () => new Error('redis cluster command timed out after 3000ms');

/** Flush queued microtasks so a concurrent caller reaches the fail-open path. */
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

/**
 * A published, PUBLIC, covered version whose model carries BOTH moderation flags, marked
 * `InternalGeneration`. That last field is the per-user split: moderators can generate with it,
 * everyone else cannot — so the two callers below genuinely disagree on `canGenerate` while
 * reading the very same cached record.
 */
const dbRow = () => ({
  id: VERSION_ID,
  name: 'v1',
  trainedWords: [],
  clipSkip: null,
  vaeId: null,
  baseModel: 'SD 1.5',
  settings: null,
  availability: 'Public',
  aliasId: null,
  covered: true,
  status: 'Published',
  usageControl: 'InternalGeneration',
  flags: 0,
  hasAccess: false,
  model: { id: 99, name: 'A Model', type: 'LORA', nsfw: false, poi: false, userId: 777, minor: true, sfwOnly: true },
});

/** Holds the origin query open so a second caller joins the SAME degraded single-flight. */
function gateOrigin() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  queryRawMock.mockImplementation(async () => {
    await gate;
    return [dbRow()];
  });
  return { gate, release: () => release() };
}

const MOD = { id: 1, isModerator: true };
const ANON = {};

beforeEach(() => {
  mGetMock.mockReset().mockRejectedValue(REDIS_TIMEOUT());
  setMock.mockClear();
  setNxMock.mockClear();
  delMock.mockClear();
  degradedInc.mockClear();
  originFetchInc.mockClear();
  queryRawMock.mockReset();
});

describe('getResourceData — per-user moderation-flag stripping is caller-local', () => {
  /**
   * POSITIVE CONTROL for the harness, not for the fix.
   *
   * Proves this setup really does put two callers on ONE shared record with ONE shared nested
   * `model` object — i.e. the harness is capable of observing the aliasing. It asserts the CACHE
   * layer's behaviour, which this change deliberately does not alter, so it must pass before and
   * after. If it ever fails, the shared cache layer started deep-cloning (filed separately) and
   * these tests are no longer exercising a shared object.
   */
  it('CONTROL: two callers joining one degraded flight share the SAME nested `model` object', async () => {
    const { release } = gateOrigin();

    const p1 = resourceDataCache.fetch([VERSION_ID]);
    await flush();
    const p2 = resourceDataCache.fetch([VERSION_ID]);
    await flush();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // One origin query served both callers => a genuinely joined single-flight.
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(degradedInc).toHaveBeenCalledTimes(2);
    // Top level is cloned per caller...
    expect(r1[0]).not.toBe(r2[0]);
    // ...the nested `model` is NOT.
    expect(r1[0].model).toBe(r2[0].model);
  });

  it('a non-generating caller does NOT strip the flags from a concurrent caller who CAN generate', async () => {
    const { release } = gateOrigin();

    // The moderator can generate with an InternalGeneration resource; the anonymous caller cannot.
    const pMod = getResourceData([VERSION_ID], { user: MOD });
    await flush();
    const pAnon = getResourceData([VERSION_ID], { user: ANON });
    await flush();
    release();
    const [modResources, anonResources] = await Promise.all([pMod, pAnon]);

    // Both callers really did join ONE degraded window over ONE record.
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(modResources).toHaveLength(1);
    expect(anonResources).toHaveLength(1);
    expect(modResources[0].canGenerate).toBe(true);
    expect(anonResources[0].canGenerate).toBe(false);

    // The moderator CAN generate, so the client-side content-restriction warning must survive.
    expect(modResources[0].model.sfwOnly).toBe(true);
    expect(modResources[0].model.minor).toBe(true);
  });

  it('still strips the flags for the caller who cannot generate', async () => {
    const { release } = gateOrigin();

    const pMod = getResourceData([VERSION_ID], { user: MOD });
    await flush();
    const pAnon = getResourceData([VERSION_ID], { user: ANON });
    await flush();
    release();
    const [, anonResources] = await Promise.all([pMod, pAnon]);

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect('sfwOnly' in anonResources[0].model).toBe(false);
    expect('minor' in anonResources[0].model).toBe(false);
  });

  it('does not write the stripped shape back into the shared cached record', async () => {
    const { release } = gateOrigin();

    const pAnon = getResourceData([VERSION_ID], { user: ANON });
    await flush();
    const pRaw = resourceDataCache.fetch([VERSION_ID]);
    await flush();
    release();
    const [anonResources, raw] = await Promise.all([pAnon, pRaw]);

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect('sfwOnly' in anonResources[0].model).toBe(false);
    // The record itself is untouched — a later reader still sees the flags.
    expect(raw[0].model.sfwOnly).toBe(true);
    expect(raw[0].model.minor).toBe(true);
  });
});
