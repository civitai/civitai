import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitWorkflow = vi.fn();
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  getGetUrl: vi.fn(),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(),
}));
vi.mock('~/server/services/training.service', () => ({ getTrainingServiceStatus: vi.fn() }));

import { createTrainingWhatIfWorkflow } from '~/server/services/orchestrator/training/training.orch';

describe('AI Toolkit training requests', () => {
  beforeEach(() => {
    submitWorkflow.mockReset();
    submitWorkflow.mockResolvedValue({ cost: { total: 100, fees: {} }, steps: [{}] });
  });

  const quote = (
    ecosystem: string,
    samplesOverrides?: { lyrics?: string; duration?: number; steps?: number; bpm?: number }[]
  ) =>
    createTrainingWhatIfWorkflow({
      token: 't',
      currencies: [],
      model: 'urn:air:yue2:checkpoint:civitai:2944296@3337846',
      priority: 'normal',
      engine: 'ai-toolkit',
      ecosystem,
      trainingDataImagesCount: 10,
      samplePrompts: ['<CAPTION>Acoustic folk</CAPTION><LYRICS>Sing together</LYRICS>'],
      samplesOverrides,
      steps: 3000,
      epochs: 10,
      batchSize: 1,
      resolution: 1024,
      lr: 0.0001,
      textEncoderLr: 0,
      trainTextEncoder: false,
      lrScheduler: 'constant',
      optimizerType: 'adamw8bit',
      networkDim: 32,
      networkAlpha: 32,
      noiseOffset: 0,
      minSnrGamma: 0,
      flipAugmentation: false,
      shuffleTokens: false,
      keepTokens: 0,
    });

  it.each(['qwen21', 'ming', 'yue2'])(
    'sends the %s discriminator without computed outputs',
    async (ecosystem) => {
      await quote(ecosystem);
      const input = submitWorkflow.mock.calls[0][0].body.steps[0].input;
      expect(input).toMatchObject({ ecosystem, engine: 'ai-toolkit', steps: 3000, batchSize: 1 });
      expect(input).not.toHaveProperty('defaultSteps');
      expect(input).not.toHaveProperty('usesStepPricing');
      expect(input).not.toHaveProperty('storageBuzzPerEpoch');
      expect(input).not.toHaveProperty('modelVariant');
    }
  );

  it('quotes YuE2 with the selected sample duration and preserves lyrics', async () => {
    await quote('yue2', [{ duration: 30, lyrics: 'Edited lyrics', steps: 32, bpm: 120 }]);
    const input = submitWorkflow.mock.calls[0][0].body.steps[0].input;
    expect(input.samples.prompts).toEqual(['Acoustic folk\n[Lyrics]\nSing together']);
    expect(input.samplesOverrides).toEqual([{ duration: 30, lyrics: 'Edited lyrics', steps: 32 }]);
    expect(input.samples).not.toHaveProperty('cfgScale');
  });

  it('rejects out-of-range YuE2 sample settings before submitting', async () => {
    await expect(quote('yue2', [{ steps: 101 }])).rejects.toThrow();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('preserves ACE-Step sample controls', async () => {
    await quote('ace_step_15', [{ steps: 150, bpm: 120 }]);
    const input = submitWorkflow.mock.calls[0][0].body.steps[0].input;
    expect(input.samplesOverrides).toEqual([{ steps: 150, bpm: 120 }]);
    expect(input.samples.prompts[0]).toContain('<CAPTION>');
  });
});
