import { beforeEach, describe, expect, it, vi } from 'vitest';

/** With the kohyaTraining flag off, a version that still carries the Kohya engine is refused
 *  before the version is claimed or a workflow is submitted (and so before any charge). */

vi.mock('~/server/services/orchestrator/workflows', () => ({ submitWorkflow: vi.fn() }));
vi.mock('~/server/services/training.service', () => ({
  getTrainingServiceStatus: vi.fn(async () => ({ available: true, blockedModels: [] })),
}));
vi.mock('~/utils/s3-utils', () => ({
  getGetUrl: vi.fn(async () => ({ url: 'https://example.com/data.zip' })),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(() => false),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  classifyPromptExternally: vi.fn(async () => ({ categories: [], externalError: null })),
}));

import { createTrainingWorkflow } from '~/server/services/orchestrator/training/training.orch';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

const givenKohyaSdxlVersion = () => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel: 'sdxl',
        baseModelType: 'sdxl',
        params: {
          engine: 'kohya',
          maxTrainEpochs: 10,
          numRepeats: 10,
          trainBatchSize: 2,
          resolution: 1024,
          optimizerType: 'Adafactor',
        },
        samplePrompts: ['a', 'b', 'c'],
      },
      modelName: 'Test LoRA',
      trainedWords: ['mystyle'],
      userId: 7,
      trainingUrl: 'https://example.com/data.zip',
      fileId: 900,
      fileMetadata: {},
      modelVersionId: 55,
      modelVersionMetadata: {},
    },
  ]);
  dbMock.dbWrite.modelFile.count.mockResolvedValue(1);
};

const submit = (kohyaTraining: boolean) =>
  createTrainingWorkflow({
    modelVersionId: 55,
    token: 'tok',
    user: { id: 7, isModerator: false } as never,
    features: { kohyaTraining, trainingStepsPricing: true } as never,
    domain: 'red',
  } as never);

describe('createTrainingWorkflow Kohya gate', () => {
  beforeEach(() => {
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.mocked(submitWorkflow).mockReset();
    vi.mocked(submitWorkflow).mockResolvedValue({
      id: 'wf-1',
      transactions: { list: [] },
    } as never);
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.updateMany.mockReset();
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
    givenKohyaSdxlVersion();
  });

  it('refuses a Kohya run before claiming the version or submitting when Kohya is off', async () => {
    await expect(submit(false)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/switch this run to AI Toolkit/),
    });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('still submits a Kohya run while Kohya is on', async () => {
    await submit(true);
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});
