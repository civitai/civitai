import { describe, expect, it } from 'vitest';
import type { Workflow } from '@civitai/client';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type { TrainingWorkflowOverlay } from '~/server/services/orchestrator/training/workflow-state';
import {
  applyTrainingWorkflowOverlay,
  collectTrainingWorkflowRefs,
  deriveTrainingWorkflowState,
  emptyTrainingOverlay,
} from '~/server/services/orchestrator/training/workflow-state';
import { TrainingStatus } from '~/shared/utils/prisma/enums';

const MODEL_FILE_ID = 42;

function workflow({
  status = 'succeeded',
  epochs = [{ epochNumber: 1, blobUrl: 'https://blob/e1.safetensors', blobSize: 10 }],
  moderationStatus,
  startedAt = '2026-08-01T00:00:00.000Z',
  completedAt = '2026-08-01T01:00:00.000Z',
}: {
  status?: string;
  epochs?: unknown[];
  moderationStatus?: string;
  startedAt?: string | null;
  completedAt?: string | null;
} = {}) {
  return {
    id: 'wf-1',
    createdAt: '2026-07-31T23:00:00.000Z',
    status,
    transactions: { list: [{ amount: 500, type: 'debit', accountType: 'blue' }] },
    steps: [
      {
        $type: 'imageResourceTraining',
        metadata: { modelFileId: MODEL_FILE_ID },
        startedAt,
        completedAt,
        output: { epochs, sampleImagesPrompts: ['a prompt'], moderationStatus },
      },
    ],
  } as unknown as Workflow;
}

function overlayOf(wf: Workflow, status = 'succeeded'): TrainingWorkflowOverlay {
  const derived = deriveTrainingWorkflowState(wf, status as never);
  return { byModelFileId: new Map([[derived.modelFileId, derived]]), truncated: false };
}

function version(
  trainingStatus: TrainingStatus | null,
  trainingResults?: Partial<TrainingResultsV2>
) {
  return {
    id: 7,
    trainingStatus,
    files: [{ id: MODEL_FILE_ID, metadata: trainingResults ? { trainingResults } : {} }],
  };
}

describe('deriveTrainingWorkflowState', () => {
  it('maps workflow status and epochs into our stored shape', () => {
    const derived = deriveTrainingWorkflowState(workflow(), 'succeeded' as never);

    expect(derived.modelFileId).toBe(MODEL_FILE_ID);
    expect(derived.trainingStatus).toBe(TrainingStatus.InReview);
    expect(derived.epochs).toEqual([
      { epochNumber: 1, modelUrl: 'https://blob/e1.safetensors', modelSize: 10, sampleImages: [] },
    ]);
    expect(derived.completedAt).toBe('2026-08-01T01:00:00.000Z');
    expect(derived.transactionData).toEqual([{ amount: 500, type: 'debit', accountType: 'blue' }]);
  });

  it('lets moderation override the workflow status', () => {
    expect(
      deriveTrainingWorkflowState(
        workflow({ moderationStatus: 'underReview' }),
        'succeeded' as never
      ).trainingStatus
    ).toBe(TrainingStatus.Paused);
    expect(
      deriveTrainingWorkflowState(workflow({ moderationStatus: 'rejected' }), 'succeeded' as never)
        .trainingStatus
    ).toBe(TrainingStatus.Denied);
  });

  it('keeps Expired over a rejection, since the rejection was the timeout', () => {
    const derived = deriveTrainingWorkflowState(
      workflow({ status: 'expired', moderationStatus: 'rejected' }),
      'expired' as never
    );
    expect(derived.trainingStatus).toBe(TrainingStatus.Expired);
  });

  it('returns nulls rather than inventing timestamps the workflow does not carry', () => {
    const derived = deriveTrainingWorkflowState(
      workflow({ startedAt: null, completedAt: null }),
      'processing' as never
    );
    expect(derived.startedAt).toBeNull();
    expect(derived.completedAt).toBeNull();
  });
});

describe('applyTrainingWorkflowOverlay', () => {
  it('replaces a stale stored status with the live one', () => {
    const row = version(TrainingStatus.Processing, {
      version: 2,
      workflowId: 'wf-1',
      submittedAt: '2026-07-31T23:00:00.000Z',
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: null,
      epochs: [],
      history: [{ time: '2026-08-01T00:00:00.000Z', status: TrainingStatus.Processing }],
      sampleImagesPrompts: [],
      transactionData: [],
    });

    const result = applyTrainingWorkflowOverlay(row, overlayOf(workflow()));

    expect(result.trainingStatus).toBe(TrainingStatus.InReview);
    expect(result.files[0].metadata.trainingResults.epochs).toHaveLength(1);
    expect(result.files[0].metadata.trainingResults.completedAt).toBe('2026-08-01T01:00:00.000Z');
  });

  it('records the surfaced status in the history the UI timeline reads', () => {
    const row = version(TrainingStatus.Processing, {
      history: [{ time: '2026-08-01T00:00:00.000Z', status: TrainingStatus.Processing }],
    } as Partial<TrainingResultsV2>);

    const history = applyTrainingWorkflowOverlay(row, overlayOf(workflow())).files[0].metadata
      .trainingResults.history;

    expect(history).toHaveLength(2);
    expect(history[1]).toEqual({
      time: '2026-08-01T01:00:00.000Z',
      status: TrainingStatus.InReview,
    });
  });

  it('does not duplicate a history entry when the live status already matches', () => {
    const row = version(TrainingStatus.InReview, {
      history: [{ time: '2026-08-01T01:00:00.000Z', status: TrainingStatus.InReview }],
    } as Partial<TrainingResultsV2>);

    expect(
      applyTrainingWorkflowOverlay(row, overlayOf(workflow())).files[0].metadata.trainingResults
        .history
    ).toHaveLength(1);
  });

  it('leaves an Approved row alone — the user already picked an epoch and published', () => {
    const row = version(TrainingStatus.Approved, {
      epochs: [{ epochNumber: 9, modelUrl: 'published', modelSize: 1, sampleImages: [] }],
    } as Partial<TrainingResultsV2>);

    const result = applyTrainingWorkflowOverlay(row, overlayOf(workflow()));

    expect(result.trainingStatus).toBe(TrainingStatus.Approved);
    expect(result.files[0].metadata.trainingResults.epochs[0].modelUrl).toBe('published');
  });

  it('leaves a row whose workflow is past retention on its stored state', () => {
    const row = version(TrainingStatus.InReview, {
      epochs: [{ epochNumber: 3, modelUrl: 'stored', modelSize: 1, sampleImages: [] }],
    } as Partial<TrainingResultsV2>);
    const unrelated = overlayOf(workflow());
    unrelated.byModelFileId = new Map([[999, unrelated.byModelFileId.get(MODEL_FILE_ID)!]]);

    const result = applyTrainingWorkflowOverlay(row, unrelated);

    expect(result).toBe(row);
    expect(result.files[0].metadata.trainingResults.epochs[0].modelUrl).toBe('stored');
  });

  it('is a no-op when the overlay is empty, so an orchestrator outage changes nothing', () => {
    const row = version(TrainingStatus.Processing);
    expect(applyTrainingWorkflowOverlay(row, emptyTrainingOverlay())).toBe(row);
  });

  it('keeps a started run started when a later workflow read omits startedAt', () => {
    const row = version(TrainingStatus.Processing, {
      startedAt: '2026-08-01T00:00:00.000Z',
    } as Partial<TrainingResultsV2>);

    const result = applyTrainingWorkflowOverlay(
      row,
      overlayOf(workflow({ startedAt: null, completedAt: null }))
    );

    expect(result.files[0].metadata.trainingResults.startedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('does not mutate the row it was given', () => {
    const row = version(TrainingStatus.Processing, { epochs: [] } as Partial<TrainingResultsV2>);
    applyTrainingWorkflowOverlay(row, overlayOf(workflow()));

    expect(row.trainingStatus).toBe(TrainingStatus.Processing);
    expect(row.files[0].metadata.trainingResults.epochs).toEqual([]);
  });
});

describe('collectTrainingWorkflowRefs', () => {
  it('pairs each stored workflow id with the file that carries it', () => {
    const rows = [
      version(TrainingStatus.Processing, { workflowId: 'wf-a' } as Partial<TrainingResultsV2>),
      version(TrainingStatus.InReview, { workflowId: 'wf-b' } as Partial<TrainingResultsV2>),
    ];

    expect(collectTrainingWorkflowRefs(rows)).toEqual([
      { modelFileId: MODEL_FILE_ID, workflowId: 'wf-a' },
      { modelFileId: MODEL_FILE_ID, workflowId: 'wf-b' },
    ]);
  });

  it('skips rows the overlay would refuse anyway, rather than fetching for nothing', () => {
    const rows = [
      version(TrainingStatus.Approved, { workflowId: 'wf-a' } as Partial<TrainingResultsV2>),
      version(TrainingStatus.Pending),
    ];

    expect(collectTrainingWorkflowRefs(rows)).toEqual([]);
  });
});
