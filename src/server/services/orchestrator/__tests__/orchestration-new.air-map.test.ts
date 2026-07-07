import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * StrictAirMap.getOrThrow fault classification.
 *
 * A missing AIR means the submitted generation form references a resource that
 * did NOT enrich (deleted/unavailable resource, or a form↔enrichment mismatch) —
 * a CLIENT/DATA fault. It must throw a BAD_REQUEST TRPCError (so
 * `classifyErrorFault` treats it as a client fault → HTTP 400 + info-level log),
 * NOT a plain `Error` that tRPC wraps into a generic INTERNAL_SERVER_ERROR (500).
 * This was ~10% of the orchestrator.whatIfFromGraph / generateFromGraph 500s.
 *
 * The mock preamble mirrors the sibling
 * `orchestration-new.getGenerationStatus.sysredis-soft.test.ts`: it keeps the heavy
 * DB / redis / generation.service module graph inert so the module imports cleanly
 * (StrictAirMap only depends on the real `throwBadRequestError`).
 */

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({ createLagTracker: vi.fn(() => ({})), loadDbEnv: vi.fn(() => ({})) }));
vi.mock('~/server/services/generation/generation.service', () => ({
  getGenerationEcosystemConfig: vi.fn(async () => ({
    experimentalEcosystems: [],
    hasTestingAccess: false,
  })),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import { StrictAirMap } from '~/server/services/orchestrator/orchestration-new.service';

describe('StrictAirMap.getOrThrow', () => {
  it('returns the AIR for a present resource id', () => {
    const map = new StrictAirMap([[123, 'urn:air:sdxl:model:civitai:123@456']]);
    expect(map.getOrThrow(123)).toBe('urn:air:sdxl:model:civitai:123@456');
  });

  it('throws a BAD_REQUEST TRPCError (client fault) for a missing resource id — NOT a plain Error / 500', () => {
    const map = new StrictAirMap();

    const err = (() => {
      try {
        map.getOrThrow(3005242);
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(TRPCError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    // Message preserved verbatim so moderators still see which resource + the cause.
    expect((err as TRPCError).message).toBe(
      'AIR not found for resource ID 3005242. ' +
        'This indicates a mismatch between form data and enriched resources.'
    );
  });
});
