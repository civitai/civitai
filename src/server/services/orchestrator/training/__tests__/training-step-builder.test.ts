import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from '~/server/common/constants';
import { OrchPriorityTypes } from '~/server/common/enums';

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: (...a: unknown[]) => mockSubmitWorkflow(...a),
}));
// Cut the heavy storage/training-service graph `training.orch` imports; nothing
// here reaches it.
vi.mock('~/server/services/training.service', () => ({ getTrainingServiceStatus: vi.fn() }));
vi.mock('~/utils/s3-utils', () => ({
  getGetUrl: vi.fn(),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(() => false),
}));

import { createTrainingWhatIfWorkflow } from '../training.orch';

/**
 * The ai-toolkit `training` step builder, as the training FORM reaches it (zip
 * dataset). INVARIANT GUARD for the extraction of `buildAiToolkitTrainingStep`: the
 * form's step must be byte-identical before and after it — pinned as a literal, so
 * this file is green on the pre-extraction code too.
 */

const PARAMS = {
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
} as const;

beforeEach(() => {
  mockSubmitWorkflow.mockReset();
  mockSubmitWorkflow.mockResolvedValue({ cost: { total: 100, fees: {} }, steps: [] });
});

describe('the training form’s ai-toolkit step (zip dataset)', () => {
  it('is the exact step the form has always sent', async () => {
    await createTrainingWhatIfWorkflow({
      token: 't',
      model: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
      priority: OrchPriorityTypes.Low,
      trainingDataImagesCount: 12,
      samplePrompts: ['a', 'b'],
      ...PARAMS,
    } as never);
    const step = mockSubmitWorkflow.mock.calls[0][0].body.steps[0];
    expect(JSON.parse(JSON.stringify(step))).toEqual({
      $type: 'training',
      metadata: { modelFileId: -1 },
      priority: 'low',
      retries: constants.maxTrainingRetries,
      input: {
        engine: 'ai-toolkit',
        ecosystem: 'sdxl',
        trainingData: { type: 'zip', sourceUrl: 'https://fake', count: 12 },
        samples: { prompts: ['a', 'b'] },
        steps: 1500,
        epochs: 5,
        batchSize: 2,
        lr: 0.0001,
        trainTextEncoder: false,
        lrScheduler: 'cosine',
        optimizerType: 'adamw8bit',
        networkDim: 32,
        networkAlpha: 16,
        flipAugmentation: false,
        shuffleTokens: false,
        keepTokens: 0,
        triggerWord: '',
        model: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
        minSnrGamma: 5,
      },
    });
    // Key order on the step, which is what goes on the wire.
    expect(Object.keys(step)).toEqual(['$type', 'metadata', 'priority', 'retries', 'input']);
  });
});
