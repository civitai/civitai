import { beforeEach, describe, expect, it, vi } from 'vitest';

/** An AI Toolkit run on a catalog base model trains the ecosystem/variant that base model maps
 *  to; params naming another one are refused before the version is claimed or submitted. */

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

const givenAiToolkitSdxlVersion = (aiToolkit: { ecosystem: string; modelVariant?: string }) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel: 'sdxl',
        baseModelType: 'sdxl',
        params: {
          engine: 'ai-toolkit',
          ...aiToolkit,
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

const submit = () =>
  createTrainingWorkflow({
    modelVersionId: 55,
    token: 'tok',
    user: { id: 7, isModerator: false } as never,
    features: { aiToolkitDefaultSd: true, trainingStepsPricing: true } as never,
    domain: 'red',
  } as never);

describe('createTrainingWorkflow AI Toolkit base model binding', () => {
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
  });

  it('refuses params naming an ecosystem the base model does not map to', async () => {
    givenAiToolkitSdxlVersion({ ecosystem: 'wan', modelVariant: '2.2' });
    await expect(submit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a model variant the base model does not map to', async () => {
    givenAiToolkitSdxlVersion({ ecosystem: 'sdxl', modelVariant: '2.2' });
    await expect(submit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('submits params that match the base model', async () => {
    givenAiToolkitSdxlVersion({ ecosystem: 'sdxl' });
    await submit();
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});
