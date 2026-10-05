import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The offset is STAMPED here, at submit, and only read at ingest. Nothing else in the suite
 * exercises that: the ingest tests inject a stored offset, and `resolveEpochOffset` is pure — so
 * without this file, deleting the field from `createTrainingWorkflow` leaves every test green and
 * every future continuation silently unshifted.
 */

vi.mock('~/server/services/orchestrator/workflows', () => ({ submitWorkflow: vi.fn() }));
vi.mock('~/server/services/training.service', () => ({
  getTrainingServiceStatus: vi.fn(async () => ({ available: true, blockedModels: [] })),
}));
vi.mock('~/utils/s3-utils', () => ({
  getGetUrl: vi.fn(async () => ({ url: 'https://example.com/data.zip' })),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(() => false),
}));

import { TRPCError } from '@trpc/server';
import { createTrainingWorkflow } from '~/server/services/orchestrator/training/training.orch';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getTrainingServiceStatus } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

const MODEL_VERSION_ID = 55;
const MODEL_FILE_ID = 900;
const USER_ID = 7;

const aiToolkitParams = {
  engine: 'ai-toolkit',
  ecosystem: 'krea2',
  steps: 2000,
  epochs: 10,
  batchSize: 1,
  resolution: 1024,
  lr: 1e-4,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'constant',
  optimizerType: 'adamw8bit',
  networkDim: 32,
  networkAlpha: 32,
  noiseOffset: null,
  minSnrGamma: null,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};

const givenTrainingRow = (trainingDetailsExtra: Record<string, unknown>, fileMetadata = {}) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel: 'krea2',
        baseModelType: 'krea2',
        params: aiToolkitParams,
        samplePrompts: ['a', 'b', 'c'],
        ...trainingDetailsExtra,
      },
      modelName: 'Test LoRA',
      trainedWords: ['trigger'],
      userId: USER_ID,
      trainingUrl: 'https://example.com/data.zip',
      fileId: MODEL_FILE_ID,
      fileMetadata,
      modelVersionId: MODEL_VERSION_ID,
      modelVersionMetadata: {},
    },
  ]);
};

const submit = (domain: 'green' | 'blue' | 'red' = 'blue') =>
  createTrainingWorkflow({
    modelVersionId: MODEL_VERSION_ID,
    token: 'tok',
    user: { id: USER_ID, isModerator: false } as never,
    features: { trainingStepsPricing: true } as never,
    domain,
  } as never);

const writtenOffset = () => {
  const call = dbMock.dbWrite.modelFile.update.mock.calls.at(-1)?.[0] as {
    data: { metadata: { trainingResults: { epochOffset?: number } } };
  };
  return call.data.metadata.trainingResults.epochOffset;
};

describe('createTrainingWorkflow epoch offset', () => {
  beforeEach(() => {
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.mocked(submitWorkflow).mockResolvedValue({
      id: 'wf-1',
      transactions: { list: [] },
    } as never);
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  it('stamps the source epoch when the run continues another', async () => {
    givenTrainingRow({
      continueFromEpoch: { air: 'urn:air:krea2:lora:civitai:1@2', epochNumber: 10 },
    });

    await submit();

    expect(writtenOffset()).toBe(10);
  });

  it('stamps zero for a run that continues nothing', async () => {
    givenTrainingRow({});

    await submit();

    expect(writtenOffset()).toBe(0);
  });

  it('keeps an offset already stamped on the run', async () => {
    givenTrainingRow(
      { continueFromEpoch: { air: 'urn:air:krea2:lora:civitai:1@2', epochNumber: 99 } },
      { trainingResults: { version: 2, epochOffset: 10, epochs: [] } }
    );

    await submit();

    expect(writtenOffset()).toBe(10);
  });

  it('clamps the -1 unknown-epoch sentinel rather than shifting backwards', async () => {
    givenTrainingRow({
      continueFromEpoch: { air: 'urn:air:krea2:lora:civitai:1@2', epochNumber: -1 },
    });

    await submit();

    expect(writtenOffset()).toBe(0);
  });
});

describe('createTrainingWorkflow domain gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.mocked(submitWorkflow).mockResolvedValue({
      id: 'wf-1',
      transactions: { list: [] },
    } as never);
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  it('refuses a red-prepared dataset paid for on green, without submitting', async () => {
    givenTrainingRow({}, { uploadDomain: 'red' });

    await expect(submit('green')).rejects.toThrow('must be submitted there');
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
  });

  it('allows a red-prepared dataset to be submitted on red', async () => {
    givenTrainingRow({}, { uploadDomain: 'red' });

    await submit('red');

    expect(submitWorkflow).toHaveBeenCalledOnce();
  });

  it('allows a green-prepared dataset on green', async () => {
    givenTrainingRow({}, { uploadDomain: 'green' });

    await submit('green');

    expect(submitWorkflow).toHaveBeenCalledOnce();
  });

  it('allows a legacy dataset with no stamped domain on green', async () => {
    givenTrainingRow({}, {});

    await submit('green');

    expect(submitWorkflow).toHaveBeenCalledOnce();
  });
});

describe('createTrainingWorkflow single submission per version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.mocked(submitWorkflow).mockResolvedValue({
      id: 'wf-1',
      transactions: { list: [] },
    } as never);
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
    givenTrainingRow({});
  });

  it('claims only a Pending or unset version before submitting', async () => {
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });

    await submit();

    expect(dbMock.dbWrite.modelVersion.updateMany).toHaveBeenCalledWith({
      where: {
        id: MODEL_VERSION_ID,
        OR: [{ trainingStatus: null }, { trainingStatus: 'Pending' }],
      },
      data: { trainingStatus: 'Submitted' },
    });
    expect(submitWorkflow).toHaveBeenCalledOnce();
  });

  it('refuses a version that is already claimed, without submitting', async () => {
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 0 });

    await expect(submit()).rejects.toThrow('already submitted');
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('does not claim a version the submission is refused for', async () => {
    vi.mocked(getTrainingServiceStatus).mockResolvedValueOnce({
      available: true,
      blockedModels: ['krea2'],
    } as never);

    await expect(submit()).rejects.toThrow('blocked from training');
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
  });

  it('releases the claim when the orchestrator rejects the submission', async () => {
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(submitWorkflow).mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'insufficient buzz' })
    );

    await expect(submit()).rejects.toThrow('insufficient buzz');
    expect(dbMock.dbWrite.modelVersion.updateMany).toHaveBeenLastCalledWith({
      where: { id: MODEL_VERSION_ID, trainingStatus: 'Submitted' },
      data: { trainingStatus: 'Pending' },
    });
  });

  it('keeps the claim when the orchestrator may have created the workflow', async () => {
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(submitWorkflow).mockRejectedValue(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'orchestrator unavailable' })
    );

    await expect(submit()).rejects.toThrow('orchestrator unavailable');
    expect(dbMock.dbWrite.modelVersion.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps the claim when a step after a successful submit fails', async () => {
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.modelFile.update.mockRejectedValue(new Error('db down'));

    await expect(submit()).rejects.toThrow('db down');
    expect(submitWorkflow).toHaveBeenCalledOnce();
    expect(dbMock.dbWrite.modelVersion.updateMany).toHaveBeenCalledTimes(1);
  });
});
