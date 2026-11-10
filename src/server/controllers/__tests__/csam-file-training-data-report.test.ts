import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import type * as CsamService from '~/server/services/csam.service';
import type * as UserService from '~/server/services/user.service';

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { createCsamReport, softDeleteUser, trackModActivity, getWorkflow } = vi.hoisted(() => ({
  createCsamReport: vi.fn(async () => undefined),
  softDeleteUser: vi.fn(async () => undefined),
  trackModActivity: vi.fn(async () => undefined),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  softDeleteUser,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trackModActivity,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({ getWorkflow }));

const { fileCsamReport } = await import('~/server/controllers/csam.controller');

const USER = 30;
const MOD = 2;
const VERSION = 77;

beforeEach(() => {
  setEnv({
    ORCHESTRATOR_ENDPOINT: 'https://orch.example',
    ORCHESTRATOR_ACCESS_TOKEN: 'orch-token',
    WEBHOOK_TOKEN: 'hook-token',
  });
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
    {
      metadata: { trainingResults: { workflowId: 'wf-1' } },
      modelVersion: { trainingStatus: 'Paused' },
    },
  ]);
  getWorkflow.mockResolvedValue({
    id: 'wf-1',
    status: 'processing',
    tags: [`modelVersion:${VERSION}`],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 }))
  );
});

afterEach(() => {
  resetEnv();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('fileCsamReport (TrainingData)', () => {
  it('records the deny under the filing moderator, not the reported user', async () => {
    const result = await fileCsamReport({
      userId: USER,
      type: 'TrainingData',
      details: { modelVersionIds: [VERSION] },
      reportedById: MOD,
    } as never);

    expect(result.denyFailed).toBe(false);
    expect(trackModActivity).toHaveBeenCalledExactlyOnceWith(MOD, {
      entityType: 'modelVersion',
      entityId: VERSION,
      activity: 'trainingData:deny',
    });
  });
});
