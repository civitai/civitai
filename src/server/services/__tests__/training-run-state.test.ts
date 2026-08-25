import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { TrainingStatus } from '~/shared/utils/prisma/enums';

/**
 * `getTrainingRunState` is what makes the epoch-selection screen orchestrator-driven. It has to be
 * authoritative when the workflow answers and invisible when it does not, because past retention
 * the stored copy is the only record of the run left.
 */

const { mockGetWorkflow, mockGetToken } = vi.hoisted(() => ({
  mockGetWorkflow: vi.fn(),
  mockGetToken: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  getOrchestratorToken: mockGetToken,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getTrainingRunState } from '~/server/services/orchestrator/training/training-state';

// Declared on dbWrite alone. The canonical mock keeps dbRead and dbWrite distinct, so this also
// pins that the service reads through the write connection — the TOASTed-metadata workaround.
const mockFindFirst = dbMock.dbWrite.modelVersion.findFirst;

const ctx = { req: {}, res: {} } as never;
const OWNER = 5;
const FILE_ID = 77;

const storedResults = {
  version: 2 as const,
  workflowId: 'wf-1',
  submittedAt: '2026-07-31T23:00:00.000Z',
  startedAt: '2026-08-01T00:00:00.000Z',
  completedAt: null,
  epochs: [{ epochNumber: 1, modelUrl: 'stored-e1', modelSize: 1, sampleImages: [] }],
  history: [{ time: '2026-08-01T00:00:00.000Z', status: TrainingStatus.Processing }],
  sampleImagesPrompts: [],
  transactionData: [],
};

function dbVersion({
  trainingStatus = TrainingStatus.Processing,
  trainingResults = storedResults as unknown,
  meta = null as unknown,
  files,
}: {
  trainingStatus?: TrainingStatus;
  trainingResults?: unknown;
  meta?: unknown;
  files?: unknown[];
} = {}) {
  return {
    trainingStatus,
    meta,
    model: { userId: OWNER },
    files: files ?? [
      {
        id: FILE_ID,
        type: 'Training Data',
        sizeKB: 10,
        metadata: trainingResults ? { trainingResults } : {},
      },
    ],
  };
}

function liveWorkflow(epochs: unknown[]) {
  return {
    id: 'wf-1',
    createdAt: '2026-07-31T23:00:00.000Z',
    status: 'succeeded',
    steps: [
      {
        $type: 'imageResourceTraining',
        metadata: { modelFileId: FILE_ID },
        startedAt: '2026-08-01T00:00:00.000Z',
        completedAt: '2026-08-01T01:00:00.000Z',
        output: { epochs, sampleImagesPrompts: ['prompt'] },
      },
    ],
  };
}

describe('getTrainingRunState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue('token');
  });

  it('serves the epochs and status from the live workflow, not the stored copy', async () => {
    mockFindFirst.mockResolvedValue(dbVersion());
    mockGetWorkflow.mockResolvedValue(
      liveWorkflow([{ epochNumber: 2, blobUrl: 'live-e2', blobSize: 20 }])
    );

    const state = await getTrainingRunState({
      modelVersionId: 1,
      userId: OWNER,
      isModerator: false,
      ctx,
    });

    expect(state.source).toBe('orchestrator');
    expect(state.trainingStatus).toBe(TrainingStatus.InReview);
    expect(state.trainingResults?.epochs).toEqual([
      { epochNumber: 2, modelUrl: 'live-e2', modelSize: 20, sampleImages: [] },
    ]);
  });

  it('falls back to the stored copy when the workflow is past retention', async () => {
    mockFindFirst.mockResolvedValue(dbVersion());
    mockGetWorkflow.mockRejectedValue(new Error('not found'));

    const state = await getTrainingRunState({
      modelVersionId: 1,
      userId: OWNER,
      isModerator: false,
      ctx,
    });

    expect(state.source).toBe('stored');
    expect(state.trainingStatus).toBe(TrainingStatus.Processing);
    expect(state.trainingResults?.epochs[0].modelUrl).toBe('stored-e1');
    expect(loggingMock.logToAxiom).toHaveBeenCalled();
  });

  it('recovers a run whose stored results were lost, via the workflow id on the version', async () => {
    // The replica drops TOASTed `ModelFile.metadata`, so `trainingResults` can come back empty on
    // a run that finished fine. `meta.trainingWorkflowId` survives that and is enough to rebuild.
    mockFindFirst.mockResolvedValue(
      dbVersion({ trainingResults: null, meta: { trainingWorkflowId: 'wf-1' } })
    );
    mockGetWorkflow.mockResolvedValue(
      liveWorkflow([{ epochNumber: 3, blobUrl: 'recovered', blobSize: 30 }])
    );

    const state = await getTrainingRunState({
      modelVersionId: 1,
      userId: OWNER,
      isModerator: false,
      ctx,
    });

    expect(mockGetWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ path: { workflowId: 'wf-1' } })
    );
    expect(state.source).toBe('orchestrator');
    expect(state.trainingResults?.epochs[0].modelUrl).toBe('recovered');
  });

  it('does not walk a published run back to InReview', async () => {
    mockFindFirst.mockResolvedValue(dbVersion({ trainingStatus: TrainingStatus.Approved }));
    mockGetWorkflow.mockResolvedValue(
      liveWorkflow([{ epochNumber: 2, blobUrl: 'live-e2', blobSize: 20 }])
    );

    const state = await getTrainingRunState({
      modelVersionId: 1,
      userId: OWNER,
      isModerator: false,
      ctx,
    });

    expect(state.trainingStatus).toBe(TrainingStatus.Approved);
  });

  it('never calls the orchestrator when there is no workflow to ask about', async () => {
    mockFindFirst.mockResolvedValue(dbVersion({ trainingResults: null }));

    const state = await getTrainingRunState({
      modelVersionId: 1,
      userId: OWNER,
      isModerator: false,
      ctx,
    });

    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(state.source).toBe('stored');
  });

  it("refuses another user's run, and does not mint a token for it", async () => {
    mockFindFirst.mockResolvedValue(dbVersion());

    await expect(
      getTrainingRunState({ modelVersionId: 1, userId: OWNER + 1, isModerator: false, ctx })
    ).rejects.toThrow();
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('lets a moderator read it', async () => {
    mockFindFirst.mockResolvedValue(dbVersion());
    mockGetWorkflow.mockResolvedValue(liveWorkflow([]));

    const state = await getTrainingRunState({
      modelVersionId: 1,
      userId: OWNER + 1,
      isModerator: true,
      ctx,
    });

    expect(state.source).toBe('orchestrator');
  });

  it('reads through the write connection, since the replica drops TOASTed metadata', async () => {
    mockFindFirst.mockResolvedValue(dbVersion());
    mockGetWorkflow.mockResolvedValue(liveWorkflow([]));

    await getTrainingRunState({ modelVersionId: 1, userId: OWNER, isModerator: false, ctx });

    expect(dbMock.dbWrite.modelVersion.findFirst).toHaveBeenCalled();
    expect(dbMock.dbRead.modelVersion.findFirst).not.toHaveBeenCalled();
  });

  it('throws when the version does not exist', async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(
      getTrainingRunState({ modelVersionId: 1, userId: OWNER, isModerator: false, ctx })
    ).rejects.toThrow();
  });
});
