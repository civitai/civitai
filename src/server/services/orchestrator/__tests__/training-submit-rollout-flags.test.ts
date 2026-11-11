import { beforeEach, describe, expect, it, vi } from 'vitest';

/** AI Toolkit-only base types pass the per-model AI Toolkit check whatever the flags say. With a
 *  type's rollout flag off, a direct API submit is refused before the version is claimed or a
 *  workflow is submitted; the flag is not only the form's. */

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
import { isAiToolkitMandatory, isAudioTrainingBaseType, trainingModelInfo } from '~/utils/training';
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
  const versionRow = [
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
  ];
  // A custom base model's weights are checked before the rollout gates: give it a SafeTensor file
  // so the cases below reach them.
  dbMock.dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('').includes("'format'") ? [{ fmt: 'SafeTensor', modelId: 1 }] : versionRow
    )) as never);
  dbMock.dbWrite.modelFile.count.mockResolvedValue(1);
};

// Every AI Toolkit-only catalog entry and the rollout flag the training form hides it behind
// (TrainingSubmitModelSelect). ACE-Step has no flag of its own: audioTraining gates it.
const ROLLOUT_FLAG_BY_MODEL: Record<string, string> = {
  qwen_image: 'qwenTraining',
  zimageturbo: 'zimageturboTraining',
  zimagebase: 'zimagebaseTraining',
  ernie: 'ernieTraining',
  hidream_o1: 'hidreamO1Training',
  anima: 'animaTraining',
  boogu: 'booguTraining',
  krea2: 'krea2Training',
  mageflow: 'mageflowTraining',
  flux2klein_4b: 'fluxTwoKleinTraining',
  flux2klein_9b: 'fluxTwoKleinTraining',
  ltx2: 'ltx2Training',
  ltx23: 'ltx23Training',
  ltx25: 'ltx25Training',
  minimaxh3: 'minimaxh3Training',
  ming: 'mingTraining',
  qwen21: 'qwen21Training',
  yue2: 'yue2Training',
};
const ALL_ON = Object.fromEntries(
  [...Object.values(ROLLOUT_FLAG_BY_MODEL), 'audioTraining'].map((flag) => [flag, true])
);

const submitWith = (features: Record<string, boolean>) =>
  createTrainingWorkflow({
    modelVersionId: 55,
    token: 'tok',
    user: { id: 7, isModerator: false } as never,
    features: {
      ...ALL_ON,
      kohyaTraining: true,
      trainingStepsPricing: true,
      ...features,
    } as never,
    domain: 'red',
  } as never);
const submit = (minimaxh3Training: boolean, audioTraining = true) =>
  submitWith({ minimaxh3Training, audioTraining });

describe('createTrainingWorkflow rollout flags', () => {
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

  it('names a flag for every AI Toolkit-only catalog entry', () => {
    const gated = Object.entries(trainingModelInfo)
      .filter(([, info]) => !info.disabled && isAiToolkitMandatory(info.type))
      .filter(([, info]) => info.type === 'yue2' || !isAudioTrainingBaseType(info.type))
      .map(([key]) => key);
    expect(gated.sort()).toEqual(Object.keys(ROLLOUT_FLAG_BY_MODEL).sort());
  });

  describe.each(Object.entries(ROLLOUT_FLAG_BY_MODEL))('%s', (model, flag) => {
    const info = trainingModelInfo[model as keyof typeof trainingModelInfo];
    beforeEach(() => {
      givenVersion({
        baseModel: model,
        baseModelType: info.type,
        params: {
          ...aiToolkitParams(info.aiToolkit!.ecosystem),
          modelVariant: info.aiToolkit!.modelVariant,
        },
      });
    });

    it(`is refused with ${flag} off`, async () => {
      const error = await submitWith({ [flag]: false }).catch((e: Error) => e);
      expect(error).toMatchObject({ code: 'BAD_REQUEST' });
      expect((error as Error).message).toMatch(
        /^(?!AI Toolkit).* training is not currently enabled\.$/
      );
      expect(submitWorkflow).not.toHaveBeenCalled();
    });

    // Control: with the flag on, the run gets past every rollout gate.
    it(`gets past the rollout gates with ${flag} on`, async () => {
      const error = await submitWith({}).catch((e: Error) => e);
      expect(String((error as Error | undefined)?.message)).not.toMatch(/not currently enabled/);
    });
  });
});
