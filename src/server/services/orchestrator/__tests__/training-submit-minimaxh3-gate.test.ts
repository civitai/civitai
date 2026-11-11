import { beforeEach, describe, expect, it, vi } from 'vitest';

/** MiniMax H3 trains on AI Toolkit only, so the per-model AI Toolkit check passes it whatever the
 *  flags say. With minimaxh3Training off, a direct API submit is refused before the version is
 *  claimed or a workflow is submitted; the flag is not only the form's. */

import type * as TrainingConstants from '~/shared/constants/training.constants';

// The classic trainer's submit is date-gated; these cases cover a run it still accepts.
vi.mock('~/shared/constants/training.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof TrainingConstants>()),
  isClassicTrainerRetired: () => false,
}));
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

const givenVersion = ({
  baseModel = 'minimaxh3',
  baseModelType = 'minimaxh3',
  ecosystem = 'minimaxh3',
} = {}) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel,
        baseModelType,
        params: {
          engine: 'ai-toolkit',
          ecosystem,
          epochs: 10,
          lr: 0.0001,
          trainTextEncoder: false,
          lrScheduler: 'constant',
          optimizerType: 'adamw8bit',
          flipAugmentation: false,
          shuffleTokens: false,
          keepTokens: 0,
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

const submit = (minimaxh3Training: boolean, audioTraining = true) =>
  createTrainingWorkflow({
    modelVersionId: 55,
    token: 'tok',
    user: { id: 7, isModerator: false } as never,
    features: { minimaxh3Training, audioTraining, trainingStepsPricing: true } as never,
    domain: 'red',
  } as never);

describe('createTrainingWorkflow MiniMax H3 gate', () => {
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
    givenVersion();
  });

  it('refuses a MiniMax H3 run before claiming the version or submitting when the flag is off', async () => {
    await expect(submit(false)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/MiniMax H3 training is not currently enabled/),
    });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  // baseModelType is written by the caller and nothing ties it to what is trained; another
  // AI Toolkit-only type passes the mandatory short-circuit and must not slip past the gate.
  it('refuses the same run when baseModelType names a different AI Toolkit-only type', async () => {
    givenVersion({ baseModelType: 'qwen' });
    await expect(submit(false)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an audio run the same way when baseModelType hides it and audioTraining is off', async () => {
    givenVersion({ baseModel: 'acestep_15', baseModelType: 'qwen', ecosystem: 'ace_step_15' });
    await expect(submit(true, false)).rejects.toMatchObject({
      message: expect.stringMatching(/Audio training is not currently enabled/),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  // A stale or mismatched baseModelType on its own is not refused: only the rollout gates read it.
  it('still submits a run whose baseModelType disagrees with the catalog when the flags allow it', async () => {
    givenVersion({ baseModelType: 'qwen' });
    await submit(true);
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('submits a MiniMax H3 run while the flag is on', async () => {
    await submit(true);
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});
