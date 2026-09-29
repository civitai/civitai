import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { loggingMock } from '~/__tests__/mocks';
import { wasServerFaultLogged } from '~/server/logging/client';

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

const logToAxiom = loggingMock.logToAxiom;

const whatIf = () =>
  createTrainingWhatIfWorkflow({
    token: 't',
    currencies: [],
    userId: 55,
    model: 'civitai:1@2',
    priority: 'normal',
    engine: 'kohya',
    trainingDataImagesCount: 10,
    samplePrompts: [],
    params: {},
  } as never);

const lastPayload = () => logToAxiom.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('createTrainingWhatIfWorkflow logging', () => {
  beforeEach(() => {
    submitWorkflow.mockReset();
    logToAxiom.mockClear();
  });

  describe('when the submit fails', () => {
    // A fresh error each time: markServerFaultLogged keys on object identity.
    const masked = () =>
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'We are having trouble reaching the generation service.',
        cause: new Error('upstream 502 pricing mage-flow'),
      });

    it('logs the orchestrator cause, not the message the user sees', async () => {
      const error = masked();
      submitWorkflow.mockRejectedValue(error);

      await expect(whatIf()).rejects.toBe(error);

      const payload = lastPayload();
      expect(JSON.stringify(payload)).toContain('upstream 502 pricing mage-flow');
      expect(payload.type).toBe('error');
      expect((payload.data as { userId: number }).userId).toBe(55);
    });

    it('marks the fault so the central chokepoint does not log it a second time', async () => {
      const error = masked();
      submitWorkflow.mockRejectedValue(error);

      await expect(whatIf()).rejects.toBe(error);

      expect(wasServerFaultLogged(error)).toBe(true);
    });

    it('keeps a rejected settings combination at info, and does not mark it', async () => {
      const error = new TRPCError({ code: 'BAD_REQUEST', message: 'resolution too high' });
      submitWorkflow.mockRejectedValue(error);

      await expect(whatIf()).rejects.toBe(error);

      expect(lastPayload().type).toBe('info');
      expect(wasServerFaultLogged(error)).toBe(false);
    });
  });

  describe('when the submit succeeds', () => {
    const priced = (total: number | null) =>
      submitWorkflow.mockResolvedValue({ cost: { total, fees: {} }, steps: [{}] });

    it('reports a missing or negative price', async () => {
      priced(null);
      await whatIf();
      expect(lastPayload().message).toBe('Orchestrator returned an unusable cost');

      logToAxiom.mockClear();
      priced(-1);
      await whatIf();
      expect(lastPayload().message).toBe('Orchestrator returned an unusable cost');
    });

    it('treats a zero price as spendable', async () => {
      priced(0);

      const result = await whatIf();

      expect(result.cost).toBe(0);
      expect(logToAxiom).not.toHaveBeenCalled();
    });
  });
});

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
