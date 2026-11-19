import { beforeEach, describe, expect, it, vi } from 'vitest';

// Trivial stubs so training.service imports in node. The @aws-sdk stub needs `default` for CJS
// interop; without it the file collects zero tests instead of failing
// (training-status.sysredis-soft.test.ts).
vi.mock('@civitai/orchestration-client', () => ({ handleError: vi.fn() }));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));
import { updateTrainingWorkflowRecords } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const MODEL_FILE_ID = 4244;
const WORKFLOW_ID = 'wf-charge';

type Tx = { type: 'debit' | 'credit'; amount: number };

const workflow = (transactions: Tx[], id = WORKFLOW_ID) =>
  ({
    id,
    status: 'processing',
    createdAt: '2026-11-07T00:00:00.000Z',
    transactions: { list: transactions },
    steps: [
      {
        $type: 'training',
        metadata: { modelFileId: MODEL_FILE_ID },
        startedAt: '2026-11-07T00:01:00.000Z',
        input: { samples: { prompts: [] } },
        output: { epochs: [] },
      },
    ],
  } as never);

const givenStored = (transactionData: Tx[]) =>
  dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({
    id: MODEL_FILE_ID,
    metadata: {
      trainingResults: {
        version: 2,
        workflowId: WORKFLOW_ID,
        epochs: [],
        history: [],
        transactionData,
      },
    },
    modelVersion: {
      id: 99,
      name: 'V1',
      model: { id: 7, name: 'Test LoRA', user: { id: 1, email: 'a@b.c', username: 'someone' } },
    },
  });

const chargeAlerts = () =>
  loggingMock.logToAxiom.mock.calls.filter(
    ([entry]) => (entry as { name?: string }).name === 'training-charge-increased'
  );

describe('updateTrainingWorkflowRecords charge increase alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
  });

  it('alerts when the workflow debits more than was charged at submit', async () => {
    givenStored([{ type: 'debit', amount: 900 }]);

    await updateTrainingWorkflowRecords(
      workflow([
        { type: 'debit', amount: 900 },
        { type: 'debit', amount: 100 },
      ]),
      'processing' as never
    );

    expect(chargeAlerts()).toHaveLength(1);
    expect(chargeAlerts()[0][0]).toMatchObject({
      data: { storedCharge: 900, currentCharge: 1000, workflowId: WORKFLOW_ID },
    });
  });

  it('stays quiet when a re-price is fully refunded', async () => {
    givenStored([{ type: 'debit', amount: 900 }]);

    await updateTrainingWorkflowRecords(
      workflow([
        { type: 'debit', amount: 900 },
        { type: 'debit', amount: 1000 },
        { type: 'credit', amount: 1000 },
      ]),
      'processing' as never
    );

    expect(chargeAlerts()).toHaveLength(0);
  });

  it('stays quiet for a run stored without a submit charge', async () => {
    givenStored([]);

    await updateTrainingWorkflowRecords(
      workflow([{ type: 'debit', amount: 1000 }]),
      'processing' as never
    );

    expect(chargeAlerts()).toHaveLength(0);
  });

  it('stays quiet for a different workflow than the one stored', async () => {
    givenStored([{ type: 'debit', amount: 900 }]);

    await updateTrainingWorkflowRecords(
      workflow([{ type: 'debit', amount: 1000 }], 'wf-other'),
      'processing' as never
    );

    expect(chargeAlerts()).toHaveLength(0);
  });
});
