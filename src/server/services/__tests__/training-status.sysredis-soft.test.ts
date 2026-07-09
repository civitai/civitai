import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

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

const { hGet, mockWithSysReadDeadline, mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  hGet: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet },
  REDIS_SYS_KEYS: { SYSTEM: { FEATURES: 'system:features' }, TRAINING: { STATUS: 'training:status' } },
  withSysReadDeadline: mockWithSysReadDeadline,
}));
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
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }));
vi.mock('@civitai/client', () => ({}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({ getS3Client: vi.fn(), deleteObject: vi.fn() }));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({ getOrchestratorCaller: vi.fn() }));

import { getTrainingServiceStatus } from '~/server/services/training.service';

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
