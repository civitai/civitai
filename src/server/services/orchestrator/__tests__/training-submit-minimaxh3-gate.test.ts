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

const aiToolkitParams = (ecosystem: string) => ({
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
});
const kohyaParams = {
  engine: 'kohya',
  maxTrainEpochs: 10,
  numRepeats: 10,
  trainBatchSize: 2,
  resolution: 1024,
  optimizerType: 'Adafactor',
};
// A non-catalog base model: a custom checkpoint AIR, so no catalog entry names its type.
const CUSTOM = 'urn:air:sdxl:checkpoint:civitai:1@2';

const givenVersion = ({
  baseModel = 'minimaxh3',
  baseModelType = 'minimaxh3',
  params = aiToolkitParams('minimaxh3') as Record<string, unknown>,
} = {}) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel,
        baseModelType,
        params,
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
    features: {
      minimaxh3Training,
      audioTraining,
      kohyaTraining: true,
      trainingStepsPricing: true,
    } as never,
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

  // baseModelType is caller-written; each case below hides the gated type from it and leaves
  // exactly one other signal of what is trained.
  const H3_OFF = /MiniMax H3 training is not currently enabled/;
  const AUDIO_OFF = /Audio training is not currently enabled/;

  it('refuses when only the catalog type of the base model says MiniMax H3', async () => {
    givenVersion({ baseModelType: 'sdxl', params: kohyaParams });
    await expect(submit(false)).rejects.toMatchObject({ message: expect.stringMatching(H3_OFF) });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses when only the AI Toolkit ecosystem in params says MiniMax H3', async () => {
    givenVersion({ baseModel: CUSTOM, baseModelType: 'qwen' });
    await expect(submit(false)).rejects.toMatchObject({ message: expect.stringMatching(H3_OFF) });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an audio run whose base model is in the catalog when audioTraining is off', async () => {
    givenVersion({ baseModel: 'acestep_15', baseModelType: 'qwen', params: kohyaParams });
    await expect(submit(true, false)).rejects.toMatchObject({
      message: expect.stringMatching(AUDIO_OFF),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an audio AI Toolkit ecosystem on a custom base model when audioTraining is off', async () => {
    givenVersion({
      baseModel: CUSTOM,
      baseModelType: 'qwen',
      params: aiToolkitParams('ace_step_15'),
    });
    await expect(submit(true, false)).rejects.toMatchObject({
      message: expect.stringMatching(AUDIO_OFF),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  // A baseModelType that disagrees with the catalog is not itself refused; only the flag gates
  // look past it.
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
