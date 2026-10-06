import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as Caches from '~/server/redis/caches';

/**
 * Every handler that makes a training-studio-born model published or public re-checks the run's
 * training-data moderation status. Only the orchestrator read and the publish writes are faked; the
 * gate itself (`assertTrainingSourcePublishable` → `assertTrainingModerationApproved`) runs for real.
 */

const {
  mockPublishModelById,
  mockGetToken,
  mockGetWorkflow,
  mockUpdateWorkflow,
  mockPrivateModelFromTraining,
  mockPublishPrivateModel,
  mockGetModel,
} = vi.hoisted(() => ({
  mockPublishModelById: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockUpdateWorkflow: vi.fn(),
  mockPrivateModelFromTraining: vi.fn(),
  mockPublishPrivateModel: vi.fn(),
  mockGetModel: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishModelById: mockPublishModelById,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
  privateModelFromTraining: mockPrivateModelFromTraining,
  publishPrivateModel: mockPublishPrivateModel,
  getModel: mockGetModel,
  getPrivateModelCount: vi.fn().mockResolvedValue(0),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn().mockResolvedValue({ productMeta: { maxPrivateModels: 5 } }),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetToken,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
  updateWorkflow: mockUpdateWorkflow,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn() },
}));

import type { Workflow } from '@civitai/client';
import { TRPCError } from '@trpc/server';
import {
  privateModelFromTrainingHandler,
  publishModelHandler,
  publishPrivateModelHandler,
} from '~/server/controllers/model.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 42;
const OWNER_ID = 7;

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

const MODERATOR_ID = 999;
const STAMPED_META = { trainingStudioWorkflowId: 'wf-1', trainingStudioModerationApproved: true };
const NOT_APPROVED = /dataset has not been approved/;

const publish = (
  user: { id: number; isModerator: boolean } = { id: OWNER_ID, isModerator: false }
) =>
  publishModelHandler({
    input: { id: MODEL_ID, versionIds: [] },
    ctx: {
      user,
      track: { modelEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    status: 'Draft',
    meta: STAMPED_META,
    nsfw: false,
    userId: OWNER_ID,
  } as never);
  mockPublishModelById.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    modelVersions: [{ id: 43 }],
  });
  mockGetToken.mockResolvedValue('owner-token');
  mockUpdateWorkflow.mockResolvedValue({});
});

describe('publishModelHandler — training moderation gate', () => {
  it('publishes a model whose training run is approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'refuses, without publishing, a model whose training run status is %s',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(trainingRun(status));
      await expect(publish()).rejects.toThrow(/dataset has not been approved/);
      expect(mockPublishModelById).not.toHaveBeenCalled();
    }
  );

  it('reads the run with the OWNER token when a moderator publishes, and still refuses a rejected run', async () => {
    // A moderator's own token cannot see the owner's workflow; reading with it would 404, which
    // the gate lets through as past-retention. The owner id must reach the token mint.
    mockGetWorkflow.mockResolvedValue(trainingRun('rejected'));
    await expect(publish({ id: MODERATOR_ID, isModerator: true })).rejects.toThrow(
      /dataset has not been approved/
    );
    expect(mockGetToken).toHaveBeenCalledWith(OWNER_ID, undefined, { bypassCache: true });
    expect(mockGetToken.mock.calls.map((call) => call[0])).toEqual([OWNER_ID]);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('re-checks on a republish too', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Unpublished',
      meta: STAMPED_META,
      nsfw: false,
      userId: OWNER_ID,
    } as never);
    mockGetWorkflow.mockResolvedValue(trainingRun('rejected'));
    await expect(publish()).rejects.toThrow(/dataset has not been approved/);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('publishes an unreadable (NOT_FOUND) run whose draft carries the approval stamp', async () => {
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it('refuses an unreadable (NOT_FOUND) run whose draft has no approval stamp', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Draft',
      meta: { trainingStudioWorkflowId: 'wf-1' },
      nsfw: false,
      userId: OWNER_ID,
    } as never);
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(publish()).rejects.toThrow(/can no longer be checked/);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('republishes an unstamped model that was published before, when its run is gone (NOT_FOUND)', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Unpublished',
      meta: { trainingStudioWorkflowId: 'wf-1' },
      nsfw: false,
      userId: OWNER_ID,
      publishedAt: new Date('2026-09-10'),
    } as never);
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it('refuses an unstamped never-published model moved to Unpublished, when its run is gone', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Unpublished',
      meta: { trainingStudioWorkflowId: 'wf-1' },
      nsfw: false,
      userId: OWNER_ID,
      publishedAt: null,
    } as never);
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(publish()).rejects.toThrow(/can no longer be checked/);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('does not read any workflow for a model with no source workflow', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Draft',
      meta: null,
      nsfw: false,
      userId: OWNER_ID,
    } as never);
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});

describe('privateModelFromTrainingHandler — training moderation gate', () => {
  const run = () =>
    privateModelFromTrainingHandler({
      input: { id: MODEL_ID, name: 'm', type: 'LORA', sfwOnly: true },
      ctx: { user: { id: OWNER_ID, isModerator: false }, track: { post: vi.fn() } },
    } as never);

  beforeEach(() => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      meta: STAMPED_META,
    } as never);
    mockPrivateModelFromTraining.mockResolvedValue({ id: MODEL_ID, modelVersions: [] });
  });

  it('publishes privately when the run is approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
    await expect(run()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockPrivateModelFromTraining).toHaveBeenCalledTimes(1);
  });

  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'refuses, without publishing, when the run status is %s',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(trainingRun(status));
      await expect(run()).rejects.toThrow(NOT_APPROVED);
      expect(mockPrivateModelFromTraining).not.toHaveBeenCalled();
    }
  );
});

describe('publishPrivateModelHandler — training moderation gate', () => {
  const run = (user = { id: OWNER_ID, isModerator: false }) =>
    publishPrivateModelHandler({
      input: { modelId: MODEL_ID, publishVersions: true },
      ctx: { user },
    } as never);

  beforeEach(() => {
    mockGetModel.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      status: 'Published',
      availability: 'Private',
      meta: STAMPED_META,
    });
    mockPublishPrivateModel.mockResolvedValue({ versionIds: [] });
  });

  it('makes the model public when the run is approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
    await expect(run()).resolves.toBe(true);
    expect(mockPublishPrivateModel).toHaveBeenCalledTimes(1);
  });

  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'refuses, without publishing, when the run status is %s',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(trainingRun(status));
      await expect(run()).rejects.toThrow(NOT_APPROVED);
      expect(mockPublishPrivateModel).not.toHaveBeenCalled();
    }
  );

  it('reads with the OWNER token when a moderator makes it public', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('rejected'));
    await expect(run({ id: MODERATOR_ID, isModerator: true })).rejects.toThrow(NOT_APPROVED);
    expect(mockGetToken.mock.calls).toEqual([[OWNER_ID, undefined, { bypassCache: true }]]);
  });

  it('makes public an unstamped privately-published model whose run is gone (NOT_FOUND)', async () => {
    mockGetModel.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      status: 'Published',
      availability: 'Private',
      meta: { trainingStudioWorkflowId: 'wf-1' },
      publishedAt: null,
    });
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(run()).resolves.toBe(true);
    expect(mockPublishPrivateModel).toHaveBeenCalledTimes(1);
  });
});
