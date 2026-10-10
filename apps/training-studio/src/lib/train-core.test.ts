import { describe, expect, it, vi } from 'vitest';
import { submitTraining, submitTrainingBatch, type TrainingRunInput } from './train-core';

const submitWorkflow = vi.fn();
// Hand-listed rather than spread over importOriginal: @civitai/client's dist imports a directory,
// which Node's ESM loader refuses when the factory resolves the real module — the main app's
// suites mock this package the same way.
vi.mock('@civitai/client', () => ({
  Air: { isAir: () => false, stringify: vi.fn() },
  getResource: vi.fn(),
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));

const client = {} as Parameters<typeof submitTraining>[0];

const baseRun = (): TrainingRunInput => ({
  ecosystem: 'sdxl',
  steps: 2000,
  epochs: 10,
  unetLr: 5e-4,
  textEncoderLr: 5e-5,
  networkDim: 32,
  networkAlpha: 32,
  resolution: 1024,
  batchSize: 4,
  lrScheduler: 'cosine',
  optimizer: 'Adafactor',
  trigger: 'ohwx',
  items: [{ air: 'blob-1', caption: 'ohwx, 1girl' }],
  prompts: ['ohwx, a photo'],
  meta: { name: 'test' },
});

describe('extra ai-toolkit fields on the wire', () => {
  it('sends only the fields the run set', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-1' } });
    await submitTraining(client, {
      ...baseRun(),
      shuffleTokens: true,
      keepTokens: 1,
      noiseOffset: 0.1,
      flipAugmentation: false,
    });
    const body = submitWorkflow.mock.calls[0]![0].body;
    const input = body.steps[0].input;
    expect(input).toMatchObject({
      shuffleTokens: true,
      keepTokens: 1,
      noiseOffset: 0.1,
      flipAugmentation: false,
    });
    expect('minSnrGamma' in input).toBe(false);
  });

  it('omits every extra field when the run carries none', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-2' } });
    await submitTraining(client, baseRun());
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    for (const key of [
      'shuffleTokens',
      'keepTokens',
      'minSnrGamma',
      'noiseOffset',
      'flipAugmentation',
    ])
      expect(key in input).toBe(false);
  });

  it('refuses a malformed extra field before anything is submitted', async () => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(submitTrainingBatch(client, [{ ...baseRun(), keepTokens: 1.5 }])).rejects.toThrow(
      /keepTokens must be an integer/
    );
    await expect(submitTrainingBatch(client, [{ ...baseRun(), minSnrGamma: -1 }])).rejects.toThrow(
      /minSnrGamma must be a non-negative number/
    );
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), shuffleTokens: 'yes' as unknown as boolean }])
    ).rejects.toThrow(/shuffleTokens must be a boolean/);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});
