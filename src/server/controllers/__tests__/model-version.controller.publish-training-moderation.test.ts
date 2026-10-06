import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as ModelService from '~/server/services/model.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as Caches from '~/server/redis/caches';

/**
 * Publishing a version of a training-studio-born model — publicly or privately — re-checks the run's
 * training-data moderation status. Only the orchestrator read and the publish writes are faked; the
 * gate (`assertTrainingSourcePublishable` → `assertTrainingModerationApproved`) runs for real.
 */

const {
  mockGetVersionById,
  mockPublishModelVersionById,
  mockUpdateModelVersionById,
  mockGetToken,
  mockGetWorkflow,
} = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
  mockPublishModelVersionById: vi.fn(),
  mockUpdateModelVersionById: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getVersionById: mockGetVersionById,
  publishModelVersionById: mockPublishModelVersionById,
  updateModelVersionById: mockUpdateModelVersionById,
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetToken,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn() },
}));

import type { Workflow } from '@civitai/client';
import {
  publishModelVersionHandler,
  publishPrivateModelVersionHandler,
} from '~/server/controllers/model-version.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VERSION_ID = 43;
const MODEL_ID = 42;
const OWNER_ID = 7;
const MODERATOR_ID = 999;
// Unstamped, so the check reads the workflow.
const META = { trainingStudioWorkflowId: 'wf-1' };
const NOT_APPROVED = /dataset has not been approved/;
const STATUSES_REFUSED = ['evaluating', 'underReview', 'rejected', undefined];

function trainingRun(moderationStatus: string | undefined): Workflow {
  return {
    id: 'wf-1',
    steps: [
      {
        $type: 'training',
        output: {
          ...(moderationStatus !== undefined && { moderationStatus }),
          epochs: [{ epochNumber: 1, model: { url: 'https://blobs/epoch-1', available: true } }],
        },
      },
    ],
  } as unknown as Workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue('owner-token');
});

describe('publishModelVersionHandler — training moderation gate', () => {
  const run = (user = { id: OWNER_ID, isModerator: false }) =>
    publishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user, track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) } },
    } as never);

  beforeEach(() => {
    mockGetVersionById.mockResolvedValue({
      meta: null,
      status: 'Draft',
      modelId: MODEL_ID,
      baseModel: 'SDXL 1.0',
      model: { userId: OWNER_ID, nsfw: false, status: 'Published', meta: META },
    });
    mockPublishModelVersionById.mockResolvedValue({
      id: VERSION_ID,
      modelId: MODEL_ID,
      model: { userId: OWNER_ID, nsfw: false },
    });
  });

  it('publishes a version when the run is approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
    await expect(run()).resolves.toMatchObject({ id: VERSION_ID });
    expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
  });

  it.each(STATUSES_REFUSED)('refuses, without publishing, when the run status is %s', async (s) => {
    mockGetWorkflow.mockResolvedValue(trainingRun(s));
    await expect(run()).rejects.toThrow(NOT_APPROVED);
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
  });

  it('reads with the OWNER token when a moderator publishes', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('rejected'));
    await expect(run({ id: MODERATOR_ID, isModerator: true })).rejects.toThrow(NOT_APPROVED);
    expect(mockGetToken.mock.calls).toEqual([[OWNER_ID, undefined, { bypassCache: true }]]);
  });
});

describe('publishPrivateModelVersionHandler — training moderation gate', () => {
  const run = () =>
    publishPrivateModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user: { id: OWNER_ID, isModerator: false }, track: { post: vi.fn() } },
    } as never);

  beforeEach(() => {
    mockGetVersionById.mockResolvedValue({
      id: VERSION_ID,
      status: 'Draft',
      uploadType: 'Trained',
      model: {
        id: MODEL_ID,
        publishedAt: null,
        availability: 'Private',
        userId: OWNER_ID,
        status: 'Published',
        meta: META,
      },
      files: [{ id: 1, metadata: {} }],
      posts: [{ id: 5 }],
    });
    dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
      { id: 1, metadata: { selectedEpochUrl: 'https://blobs/epoch-1' } },
    ] as never);
    mockUpdateModelVersionById.mockResolvedValue({ id: VERSION_ID });
  });

  it('publishes the version privately when the run is approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
    await expect(run()).resolves.toMatchObject({ id: VERSION_ID });
    expect(mockUpdateModelVersionById).toHaveBeenCalledTimes(1);
  });

  it.each(STATUSES_REFUSED)('refuses, without publishing, when the run status is %s', async (s) => {
    mockGetWorkflow.mockResolvedValue(trainingRun(s));
    await expect(run()).rejects.toThrow(NOT_APPROVED);
    expect(mockUpdateModelVersionById).not.toHaveBeenCalled();
  });
});
