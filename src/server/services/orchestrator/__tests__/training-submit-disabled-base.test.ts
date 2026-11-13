import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A `disabled` trainingModelInfo base (kept in the table so Training Studio runs on it can be
 *  published) is refused by the main-site submit before the version is claimed or a workflow is sent. */

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

const givenAiToolkitVersion = (baseModel: string, baseModelType: string, ecosystem: string) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel,
        baseModelType,
        params: { engine: 'ai-toolkit', ecosystem, steps: 2000, epochs: 5 },
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
    features: { aiToolkitWan: true, trainingStepsPricing: true } as never,
    domain: 'red',
  } as never);

describe('createTrainingWorkflow disabled base gate', () => {
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

  it.each([
    ['wan_2_1_i2v_14b_720p', 'wan', 'wan'],
    ['mossimage_base', 'mossimage', 'mossImage'],
  ])('refuses %s before claiming the version or submitting', async (key, type, ecosystem) => {
    givenAiToolkitVersion(key, type, ecosystem);
    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/not available for training/),
    });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  // A custom base names an AIR, not a catalog key, so only the type/ecosystem can refuse it.
  it('refuses a custom base whose type and ecosystem have only disabled entries', async () => {
    givenAiToolkitVersion('urn:air:ideogram4:checkpoint:civitai:1@2', 'ideogram4', 'ideogram4');
    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/not available for training/),
    });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('still submits a custom base on a type with an enabled entry', async () => {
    givenAiToolkitVersion('urn:air:wan:checkpoint:civitai:1@2', 'wan', 'wan');
    const versionRow = await dbMock.dbWrite.$queryRaw();
    dbMock.dbWrite.$queryRaw
      .mockResolvedValueOnce(versionRow)
      .mockResolvedValue([{ fmt: 'SafeTensor' }]);
    await submit();
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('still submits an enabled base', async () => {
    givenAiToolkitVersion('wan_2_2_t2v_a14b', 'wan', 'wan');
    await submit();
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});
