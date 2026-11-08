import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// Same stubs as training-status.sysredis-soft.test.ts: the real schema module is client-coupled,
// and the service's import graph pulls heavy deps that are irrelevant here.
vi.mock('~/server/schema/training.schema', () => ({
  trainingServiceStatusSchema: z.object({
    available: z.boolean().default(true),
    message: z.string().nullish(),
    blockedModels: z.array(z.string()).optional().default([]),
    blockedModelReasons: z.record(z.string(), z.string()).optional().default({}),
  }),
}));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({ getS3Client: vi.fn(), deleteObject: vi.fn() }));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));

import { setTrainingServiceStatus } from '~/server/services/training.service';

const stored = {
  available: true,
  message: null,
  blockedModels: ['urn:air:sdxl:checkpoint:civitai:1@2', 'krea2'],
  blockedModelReasons: { krea2: 'Provider outage.' },
};

const written = () => JSON.parse(redisMock.sysRedis.hSet.mock.calls.at(-1)?.[2] as string);

describe('setTrainingServiceStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.sysRedis.hGet.mockResolvedValue(JSON.stringify(stored));
  });

  it('an on/off toggle leaves the blocked models and their notes as they are', async () => {
    await setTrainingServiceStatus({ available: false, message: 'Paused.' });

    expect(written()).toMatchObject({
      available: false,
      message: 'Paused.',
      blockedModels: stored.blockedModels,
      blockedModelReasons: stored.blockedModelReasons,
    });
  });

  it('an edited list replaces the base models and keeps the custom-model AIRs', async () => {
    await setTrainingServiceStatus({ available: true, blockedModels: ['flux_dev'] });

    expect(written()).toMatchObject({
      blockedModels: ['urn:air:sdxl:checkpoint:civitai:1@2', 'flux_dev'],
      blockedModelReasons: {},
    });
  });
});
