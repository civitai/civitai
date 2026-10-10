import { describe, expect, it } from 'vitest';
import {
  BLOCK_TRAINING_SAMPLE_PROMPTS_MAX,
  blockTrainingBodySchema,
  blockTrainingDatasetItemsSchema,
  blockWorkflowBodySchema,
} from '../workflow.schema';

/**
 * The `kind:'training'` wire body. `.strict()` with NO `maxBuzz` and no timeout
 * knob: the price is the server's stored quote, never an app-supplied number.
 */

const PARAMS = {
  engine: 'ai-toolkit',
  ecosystem: 'sdxl',
  epochs: 5,
  resolution: 1024,
  lr: 0.0001,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'cosine',
  optimizerType: 'adamw8bit',
  networkDim: 32,
  networkAlpha: 16,
  noiseOffset: null,
  minSnrGamma: null,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};

const BODY = {
  kind: 'training',
  datasetId: `tds_${'a'.repeat(32)}`,
  engine: 'ai-toolkit',
  model: 'sdxl',
  params: PARAMS,
  triggerWord: 'mychar',
  samplePrompts: ['mychar on a beach'],
};

describe('blockTrainingBodySchema', () => {
  it('parses a valid body through the OUTER union, as the training member', () => {
    const parsed = blockWorkflowBodySchema.parse(BODY);
    expect(parsed.kind).toBe('training');
  });

  it('accepts a submit body naming a quote', () => {
    expect(
      blockTrainingBodySchema.safeParse({ ...BODY, quoteId: `tq_${'b'.repeat(32)}` }).success
    ).toBe(true);
  });

  it.each([
    ['a maxBuzz knob', { maxBuzz: 100 }],
    ['a timeout knob', { timeout: '01:00:00' }],
    ['an image count', { imageCount: 3 }],
    ['inline training data', { trainingData: { type: 'blobs', items: [] } }],
  ])('rejects %s (strict)', (_l, extra) => {
    expect(blockWorkflowBodySchema.safeParse({ ...BODY, ...extra }).success).toBe(false);
  });

  it.each([
    ['a malformed datasetId', { datasetId: 'tds_x' }],
    ['a malformed quoteId', { quoteId: 'tq_../x' }],
    ['another engine', { engine: 'kohya' }],
    ['an over-long trigger word', { triggerWord: 'x'.repeat(65) }],
    [
      'too many sample prompts',
      { samplePrompts: Array(BLOCK_TRAINING_SAMPLE_PROMPTS_MAX + 1).fill('p') },
    ],
    ['an over-long sample prompt', { samplePrompts: ['x'.repeat(1001)] }],
    ['an unknown ecosystem', { params: { ...PARAMS, ecosystem: 'notreal' } }],
    ['a variant the ecosystem requires missing', { params: { ...PARAMS, ecosystem: 'flux1' } }],
    ['an lr the training form refuses', { params: { ...PARAMS, lr: 0.5 } }],
  ])('rejects %s', (_l, over) => {
    expect(blockWorkflowBodySchema.safeParse({ ...BODY, ...over }).success).toBe(false);
  });

  it('accepts exactly the sample-prompt maximum (boundary control)', () => {
    expect(
      blockTrainingBodySchema.safeParse({
        ...BODY,
        samplePrompts: Array(BLOCK_TRAINING_SAMPLE_PROMPTS_MAX).fill('p'),
      }).success
    ).toBe(true);
  });

  it('leaves the other kinds parsing unchanged', () => {
    expect(
      blockWorkflowBodySchema.safeParse({
        kind: 'step',
        $type: 'imageGen',
        input: {},
        maxBuzz: 10,
      }).success
    ).toBe(true);
    expect(
      blockWorkflowBodySchema.safeParse({
        kind: 'textToImage',
        modelId: 1,
        modelVersionId: 2,
        params: { prompt: 'a cat', quantity: 1 },
      }).success
    ).toBe(true);
  });
});

describe('blockTrainingDatasetItemsSchema', () => {
  it('accepts image ids with captions and rejects anything else on an item', () => {
    expect(blockTrainingDatasetItemsSchema.safeParse([{ imageId: 1, caption: 'a' }]).success).toBe(
      true
    );
    expect(
      blockTrainingDatasetItemsSchema.safeParse([{ imageId: 1, caption: 'a', url: 'x' }]).success
    ).toBe(false);
    expect(blockTrainingDatasetItemsSchema.safeParse([]).success).toBe(false);
    expect(
      blockTrainingDatasetItemsSchema.safeParse([{ imageId: 1, caption: 'x'.repeat(1001) }]).success
    ).toBe(false);
  });
});
