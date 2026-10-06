import { beforeEach, describe, expect, it } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { constants } from '~/server/common/constants';
import {
  blockTrainingBodySchema,
  type BlockTrainingBody,
} from '~/server/schema/blocks/workflow.schema';
import type { BlockTrainingDataset } from '../block-training-dataset.service';
import {
  BLOCK_TRAINING_QUOTE_TTL_SECONDS,
  claimTrainingQuote,
  hashTrainingBody,
  readTrainingQuote,
  readTrainingRunGeneration,
  recordTrainingQuoteConsent,
  resolveBlockTrainingRun,
  storeTrainingQuote,
} from '../block-training-quote.service';

/**
 * Run resolution (the training form's server-side gates, applied to an app's body)
 * and the QUOTE record a viewer confirms and a submit claims exactly once.
 */

const DATASET: BlockTrainingDataset = {
  v: 1,
  datasetId: `tds_${'a'.repeat(32)}`,
  userId: 42,
  appBlockId: 'apb_1',
  blockInstanceId: 'page_apb_1',
  items: [
    {
      imageId: 1,
      air: 'https://o.example/v2/consumer/blobs/k1.jpeg',
      caption: 'a',
      thumbnailUrl: 't1',
    },
    {
      imageId: 2,
      air: 'https://o.example/v2/consumer/blobs/k2.jpeg',
      caption: 'b',
      thumbnailUrl: 't2',
    },
  ],
  count: 2,
  createdAt: 'x',
};

const SDXL_PARAMS = {
  engine: 'ai-toolkit',
  ecosystem: 'sdxl',
  epochs: 5,
  steps: 1500,
  batchSize: 2,
  resolution: 1024,
  lr: 0.0001,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'cosine',
  optimizerType: 'adamw8bit',
  networkDim: 32,
  networkAlpha: 16,
  noiseOffset: null,
  minSnrGamma: 5,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};

function body(over: Record<string, unknown> = {}): BlockTrainingBody {
  return blockTrainingBodySchema.parse({
    kind: 'training',
    datasetId: DATASET.datasetId,
    engine: 'ai-toolkit',
    model: 'sdxl',
    params: SDXL_PARAMS,
    triggerWord: 'mychar',
    samplePrompts: ['mychar at the beach'],
    ...over,
  });
}

const OPEN = { available: true };
const FLAGS = { aiToolkitSdxl: true, trainingStepsPricing: true };

function resolve(over: Partial<Parameters<typeof resolveBlockTrainingRun>[0]> = {}) {
  return resolveBlockTrainingRun({
    body: body(),
    dataset: DATASET,
    status: OPEN,
    features: FLAGS,
    isModerator: false,
    ...over,
  });
}

describe('resolveBlockTrainingRun — the step', () => {
  it('builds one ai-toolkit step over the stored blob dataset, with no timeout and no name', () => {
    const { step, modelKey, ecosystem, epochs, steps } = resolve();
    expect(modelKey).toBe('sdxl');
    expect(ecosystem).toBe('sdxl');
    expect(epochs).toBe(5);
    expect(steps).toBe(1500);
    expect(step.$type).toBe('training');
    expect(step.retries).toBe(constants.maxTrainingRetries);
    expect('timeout' in step).toBe(false);
    expect('name' in step).toBe(false);
    expect('metadata' in step).toBe(false);
    const input = step.input as unknown as Record<string, unknown>;
    expect(input.engine).toBe('ai-toolkit');
    // The dataset is the STORED blob list — never anything the body carried.
    expect(input.trainingData).toEqual({
      type: 'blobs',
      items: [
        { air: 'https://o.example/v2/consumer/blobs/k1.jpeg', caption: 'a' },
        { air: 'https://o.example/v2/consumer/blobs/k2.jpeg', caption: 'b' },
      ],
    });
    expect(input.triggerWord).toBe('mychar');
    expect(input.steps).toBe(1500);
    expect(input.batchSize).toBe(2);
  });

  it('strips the steps-pricing fields when that flag is off (same rule as the training form)', () => {
    const input = resolve({ features: { aiToolkitSdxl: true } }).step.input as unknown as Record<
      string,
      unknown
    >;
    expect(input.steps).toBeUndefined();
    expect(input.batchSize).toBeUndefined();
    expect(input.epochs).toBe(5);
  });

  it('falls back to the training form’s empty sample prompts when none are given', () => {
    const input = resolve({ body: body({ samplePrompts: [] }) }).step.input as unknown as {
      samples: { prompts: string[] };
    };
    expect(input.samples.prompts).toEqual(['', '', '']);
  });
});

describe('resolveBlockTrainingRun — the gates', () => {
  it('refuses while the training service is unavailable, except for a moderator', () => {
    const closed = { available: false, message: 'Training paused' };
    expect(() => resolve({ status: closed })).toThrow('Training paused');
    expect(() => resolve({ status: closed, isModerator: true })).not.toThrow();
  });

  it.each([
    ['an unknown model key', { model: 'not-a-model' }, 'unknown training base model'],
    ['a prototype key', { model: 'toString' }, 'unknown training base model'],
    [
      'a disabled catalog entry',
      {
        model: 'wan_2_1_i2v_14b_720p',
        params: { ...SDXL_PARAMS, ecosystem: 'wan', modelVariant: '2.1' },
      },
      'not available for training',
    ],
    ['an entry with no ai-toolkit config', { model: 'flux2_dev' }, 'does not support ai-toolkit'],
    [
      'a non-image base type',
      {
        model: 'wan_2_2_t2v_a14b',
        params: { ...SDXL_PARAMS, ecosystem: 'wan', modelVariant: '2.2' },
      },
      'only image training',
    ],
    [
      'params naming another ecosystem than the model',
      { model: 'sdxl', params: { ...SDXL_PARAMS, ecosystem: 'sd1' } },
      'do not match the base model',
    ],
    [
      'a continueFrom checkpoint',
      { params: { ...SDXL_PARAMS, continueFrom: 'urn:air:sdxl:lora:orchestrator:blob@x' } },
      'continuing from a checkpoint',
    ],
  ])('refuses %s', (_l, over, message) => {
    expect(() => resolve({ body: body(over) })).toThrow(message);
  });

  it('refuses a base model blocked from training', () => {
    expect(() => resolve({ status: { available: true, blockedModels: ['sdxl'] } })).toThrow(
      'blocked from training'
    );
    // Control: a different blocked model does not refuse this one.
    expect(() => resolve({ status: { available: true, blockedModels: ['pony'] } })).not.toThrow();
  });

  it('refuses when ai-toolkit is not enabled for the base type', () => {
    expect(() => resolve({ features: { trainingStepsPricing: true } })).toThrow(
      'not currently enabled'
    );
  });
});

describe('hashTrainingBody', () => {
  it('ignores quoteId and key order, and moves with every other field', () => {
    const base = hashTrainingBody(body());
    expect(hashTrainingBody(body({ quoteId: `tq_${'b'.repeat(32)}` }))).toBe(base);
    const reordered = { ...body() };
    expect(hashTrainingBody(Object.fromEntries(Object.entries(reordered).reverse()) as never)).toBe(
      base
    );
    expect(hashTrainingBody(body({ triggerWord: 'other' }))).not.toBe(base);
    expect(hashTrainingBody(body({ params: { ...SDXL_PARAMS, epochs: 6 } }))).not.toBe(base);
    expect(hashTrainingBody(body({ datasetId: `tds_${'c'.repeat(32)}` }))).not.toBe(base);
  });
});

describe('the quote record', () => {
  const binding = { userId: 42, appBlockId: 'apb_1', blockInstanceId: 'page_apb_1' };
  const fields = {
    ...binding,
    total: 1200,
    bodyHash: 'h',
    datasetId: DATASET.datasetId,
    imageCount: 2,
    modelKey: 'sdxl',
    modelName: 'SDXL',
    ecosystem: 'sdxl',
    epochs: 5,
    steps: 1500,
  };

  beforeEach(() => {
    redisMock.sysRedis.set.mockReset();
    redisMock.sysRedis.get.mockReset();
    redisMock.sysRedis.getDel.mockReset();
    redisMock.sysRedis.set.mockResolvedValue('OK');
  });

  it('is stored UNCONSENTED with a server-minted id and the quote TTL', async () => {
    const q = await storeTrainingQuote(fields);
    expect(q.quoteId).toMatch(/^tq_[a-f0-9]{32}$/);
    expect(q.consentedBy).toBeNull();
    const [key, , opts] = redisMock.sysRedis.set.mock.calls[0];
    expect(key).toBe(`system:blocks:training-quote:${q.quoteId}`);
    expect(opts).toEqual({ EX: BLOCK_TRAINING_QUOTE_TTL_SECONDS });
  });

  it('consent records the session user, keeps the TTL, and never resurrects a claimed quote', async () => {
    const q = await storeTrainingQuote(fields);
    redisMock.sysRedis.get.mockResolvedValue(redisMock.sysRedis.set.mock.calls[0][1]);
    const updated = await recordTrainingQuoteConsent(q.quoteId, binding, 42);
    expect(updated?.consentedBy).toBe(42);
    const [, value, opts] = redisMock.sysRedis.set.mock.calls[1];
    expect(JSON.parse(value as string).consentedBy).toBe(42);
    expect(opts).toEqual({ XX: true, KEEPTTL: true });
  });

  it('consent is refused for a session user who is not the quote’s subject', async () => {
    const q = await storeTrainingQuote(fields);
    redisMock.sysRedis.get.mockResolvedValue(redisMock.sysRedis.set.mock.calls[0][1]);
    expect(await recordTrainingQuoteConsent(q.quoteId, binding, 7)).toBeNull();
    expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another viewer', { ...binding, userId: 7 }],
    ['another app', { ...binding, appBlockId: 'apb_2' }],
    ['another install', { ...binding, blockInstanceId: 'page_x' }],
  ])('is unreadable for %s', async (_l, other) => {
    const q = await storeTrainingQuote(fields);
    redisMock.sysRedis.get.mockResolvedValue(redisMock.sysRedis.set.mock.calls[0][1]);
    expect(await readTrainingQuote(q.quoteId, other)).toBeNull();
    expect(await recordTrainingQuoteConsent(q.quoteId, other, other.userId)).toBeNull();
  });

  it('a claim is GETDEL — single use — and a malformed id never reaches Redis', async () => {
    const q = await storeTrainingQuote(fields);
    redisMock.sysRedis.getDel.mockResolvedValueOnce(redisMock.sysRedis.set.mock.calls[0][1]);
    expect((await claimTrainingQuote(q.quoteId))?.total).toBe(1200);
    expect(redisMock.sysRedis.getDel).toHaveBeenCalledWith(
      `system:blocks:training-quote:${q.quoteId}`
    );
    // A second claim finds nothing.
    redisMock.sysRedis.getDel.mockResolvedValueOnce(null);
    expect(await claimTrainingQuote(q.quoteId)).toBeNull();
    redisMock.sysRedis.getDel.mockClear();
    expect(await claimTrainingQuote('tq_nope')).toBeNull();
    expect(redisMock.sysRedis.getDel).not.toHaveBeenCalled();
  });
});

describe('readTrainingRunGeneration', () => {
  it.each([
    [null, 0],
    ['3', 3],
    ['-2', 0],
    ['1.5', 0],
    ['junk', 0],
  ])('reads %s as %s', async (raw, expected) => {
    redisMock.sysRedis.get.mockResolvedValueOnce(raw);
    expect(await readTrainingRunGeneration(body())).toBe(expected);
  });
});
