import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationServiceModule from '~/server/services/generation/generation.service';

/**
 * The SUBMIT path's view of the generation kill switch and the gate rules on a sysRedis failure:
 * buildGenerationContext (every generation surface: onsite, API, App Blocks) over the REAL
 * generation.service readers. Only resolveTestingAccess is stubbed.
 *
 * This file used to pin a LOCAL getGenerationStatus duplicate in orchestration-new.service.ts that
 * failed OPEN to schema defaults ("enabled") — a disabled generator read as enabled at submit. The
 * duplicate is gone; the submit path now reads the one generation.service reader, which serves
 * the last value read and, with none, fails closed.
 *
 * Fault injection: sysRedis reads that reject, and one that never settles while the read deadline
 * rejects (fail-on-revert: without the deadline the build would hang). The last-known state is
 * reset before each test.
 */

const { mockHGet, mockGet, mockHGetAll, mockWithSysReadDeadline, mockLogSysRedisFailOpen } =
  vi.hoisted(() => ({
    mockHGet: vi.fn(),
    mockGet: vi.fn(),
    mockHGetAll: vi.fn(),
    mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
    mockLogSysRedisFailOpen: vi.fn(),
  }));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: mockHGet, get: mockGet, hGetAll: mockHGetAll },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));

// The REAL kill-switch and gate-rule readers; only the testing-access flag lookup is stubbed.
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationServiceModule>()),
  resolveTestingAccess: vi.fn(async () => false),
}));
// generation.service's own heavy neighbours, never reached by these reads.
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ getLinkedVaeIds: vi.fn() }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));

// image.service (pulled transitively via cosmetic.service) imports the private
// `event-engine-common` submodule that isn't checked out here + boots DB pools;
// buildGenerationContext never uses it, so stub it out.
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import { buildGenerationContext } from '~/server/services/orchestrator/orchestration-new.service';
import * as generationService from '~/server/services/generation/generation.service';
import { __resetGenerationConfigLastKnownForTests } from '~/server/services/generation/generation.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockHGet.mockReset();
  mockGet.mockReset();
  mockHGetAll.mockReset();
  mockWithSysReadDeadline.mockReset();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  // Each test starts as a fresh process: nothing read before.
  __resetGenerationConfigLastKnownForTests();
});

const hiddenRule = {
  id: 'r1',
  name: 'pre-launch',
  availableTo: 'moderators',
  presentation: 'hidden',
  ecosystems: [],
  workflows: [],
  modelVersionIds: [123],
};

/** sysRedis answering: the kill switch, and the gate-rule hash (already migrated). */
function sysRedisUp(status: object, rules: object[] = []) {
  mockHGet.mockResolvedValue(JSON.stringify(status));
  mockGet.mockResolvedValue('1');
  mockHGetAll.mockResolvedValue(
    Object.fromEntries(rules.map((r: any) => [r.id, JSON.stringify(r)]))
  );
}
function sysRedisDown() {
  const down = () => Promise.reject(new Error('sysRedis connection is down'));
  mockHGet.mockImplementation(down);
  mockGet.mockImplementation(down);
  mockHGetAll.mockImplementation(down);
}

describe('buildGenerationContext — kill switch and gate rules on a sysRedis failure', () => {
  it('happy path: the stored status and rules reach the context', async () => {
    sysRedisUp({ mode: 'disabled', message: 'maintenance', selfHostedMode: 'memberOnly' }, [
      hiddenRule,
    ]);

    const result = await buildGenerationContext('free', {}, {}, 'onsite');

    expect(result.status).toEqual({ mode: 'disabled', message: 'maintenance' });
    expect(result.externalCtx.selfHostedMode).toBe('memberOnly');
    expect(result.externalCtx.gateRules?.map((r) => r.modelVersionIds)).toEqual([[123]]);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('sysRedis down after a "disabled" read: the generator STAYS disabled at submit', async () => {
    sysRedisUp({ mode: 'disabled', message: 'maintenance' }, [hiddenRule]);
    await buildGenerationContext('free', {}, {}, 'onsite');
    sysRedisDown();

    const result = await buildGenerationContext('free', {}, {}, 'onsite');

    expect(result.status).toEqual({ mode: 'disabled', message: 'maintenance' });
    // ...and the last-known hidden model stays gated.
    expect(result.externalCtx.gateRules?.map((r) => r.modelVersionIds)).toEqual([[123]]);
  });

  it('sysRedis down with nothing read before: refused with a clear error, never enabled', async () => {
    sysRedisDown();

    await expect(buildGenerationContext('free', {}, {}, 'onsite')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Generation is temporarily unavailable. Please try again in a few minutes.',
    });
  });

  it('...for a moderator and an App Blocks caller too', async () => {
    sysRedisDown();

    await expect(
      buildGenerationContext('free', undefined, { id: 1, isModerator: true }, 'block')
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  // The kill switch unknown while the gate rules ARE known: a model-page read cached the rules,
  // then sysRedis failed before this process ever read the status. Refused like unknown gates —
  // moderators included, every surface (the router's mode check skips moderators, and the App
  // Blocks bridge never reads `status.mode`).
  async function gatesKnownStatusNeverRead() {
    sysRedisUp({}, [hiddenRule]);
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));
    await generationService.getCanGenerateHiddenGates({}); // reads the gate rules only
    sysRedisDown();
  }

  it('kill switch unknown, gate rules known: a moderator on site is refused', async () => {
    await gatesKnownStatusNeverRead();

    await expect(
      buildGenerationContext('free', {}, { id: 1, isModerator: true }, 'onsite')
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Generation is temporarily unavailable. Please try again in a few minutes.',
    });
    expect(mockLogSysRedisFailOpen.mock.calls.map((c) => c[0])).toContain('defaults-firing');
  });

  it('kill switch unknown, gate rules known: an App Blocks caller is refused', async () => {
    await gatesKnownStatusNeverRead();

    await expect(
      buildGenerationContext('free', undefined, { id: 2, isModerator: false }, 'block')
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('kill switch last-known "enabled", then sysRedis down: generation proceeds on the known value', async () => {
    sysRedisUp({ mode: 'enabled' }, [hiddenRule]);
    await buildGenerationContext('free', {}, {}, 'onsite');
    sysRedisDown();

    const result = await buildGenerationContext('free', undefined, { id: 2 }, 'block');
    expect(result.status).toEqual({ mode: 'enabled', message: undefined });
  });

  it('SLOW/half-open: reads NEVER settle + the deadline REJECTS → refused, not hung (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockGet.mockReturnValue(new Promise(() => undefined));
    mockHGetAll.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    await expect(buildGenerationContext('free', {}, {}, 'onsite')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(2);
  });
});
