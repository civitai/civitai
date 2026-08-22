import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * STEP-7 sysRedis soft-dependency (Group A) — training.service.getTrainingServiceStatus.
 *
 * Symmetric with the getGenerationStatus wrap from STEP 6. The status read
 * (sysRedis.hGet of SYSTEM.FEATURES) was already try/catch fail-open (logs
 * 'defaults-firing', falls back to the schema '{}' default = available:true) but
 * PARKED ~11min on a silent half-open. STEP 7 adds `withSysReadDeadline` to
 * bound that park — the fail direction is unchanged (already fail-open).
 *
 * The SLOW test is fail-on-revert: the underlying hGet NEVER settles, so
 * removing the wrap would hang the call → the test would TIME OUT.
 *
 * The heavy training.service import graph (@aws-sdk, @civitai/client,
 * orchestrator caller, s3) + the client-coupled training.schema are stubbed;
 * trainingServiceStatusSchema is replaced with an equivalent local zod schema so
 * the parse still exercises the real default (available:true).
 */

const { mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  mockLogSysRedisFailOpen: vi.fn(),
}));

// The canonical redis mock (registered globally in src/__tests__/setup.ts) supplies sysRedis and
// the `withSysReadDeadline` seam. The seam matters here: it is the ONLY lever this suite has, since
// the deadline is a wall-clock race a mocked client can never lose on its own. Its canonical
// default is the REAL wrapper, so `beforeEach` below still has to make it transparent — the same
// thing the hand-rolled mock this replaces did, and what the timeout case then overrides.
//
// The local REDIS_SYS_KEYS table that used to live here is gone; the real one now reaches the
// service. Its two entries were byte-identical to the real constants
// (packages/civitai-redis/src/client.ts:1814, :1818), so no assertion changes — but nothing in this
// file was ever asserting a key, which is the reason a drifted copy could have gone unnoticed.
const hGet = redisMock.sysRedis.hGet;
const mockWithSysReadDeadline = redisMock.withSysReadDeadline;

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// Replace the client-coupled schema module with an equivalent local schema so
// getTrainingServiceStatus' safeParse/parse still exercises the real defaulting
// (available:true) without pulling ~/components / ~/store into the node graph.
vi.mock('~/server/schema/training.schema', () => ({
  trainingServiceStatusSchema: z.object({
    available: z.boolean().default(true),
    message: z.string().nullish(),
    blockedModels: z.array(z.string()).optional().default([]),
  }),
}));

// Heavy import-graph deps — trivial stubs so the module imports in node.
// `default` alongside the named export: pre-bundling wraps this CJS dep for interop, so the
// consumer resolves through `default` and a factory without one yields undefined. It fails by
// collecting almost no tests rather than by going red, so the check is the collected count.
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('@civitai/client', () => ({}));
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({ getS3Client: vi.fn(), deleteObject: vi.fn() }));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));

import { getTrainingServiceStatus } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  hGet.mockResolvedValue('{}');
});

describe('getTrainingServiceStatus — sysRedis hGet (fail-open to defaults, park-bounded)', () => {
  it('happy path: honors the stored status; read wrapped once; no fail-open log', async () => {
    hGet.mockResolvedValue(JSON.stringify({ available: false, message: 'paused' }));
    const status = await getTrainingServiceStatus();
    expect(status.available).toBe(false);
    expect(status.message).toBe('paused');
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fail-open to schema default (available:true); logSysRedisFailOpen fired', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    const status = await getTrainingServiceStatus();
    expect(status.available).toBe(true);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'defaults-firing',
      'getTrainingServiceStatus',
      expect.any(Error)
    );
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → defaults (fail-on-revert)', async () => {
    hGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    const status = await getTrainingServiceStatus();
    expect(status.available).toBe(true);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'defaults-firing',
      'getTrainingServiceStatus',
      expect.any(Error)
    );
  });
});
