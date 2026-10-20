import { describe, expect, it, vi } from 'vitest';
import { cardByType } from '$lib/data/trainingModels';
import {
  continueTraining,
  continueTrainingWhatIf,
  submitTraining,
  submitTrainingBatch,
  type TrainingRunInput,
} from './train-core';

const submitWorkflow = vi.fn();
const getWorkflow = vi.fn();
const getResource = vi.fn();
// Hand-listed rather than spread over importOriginal: @civitai/client's dist imports a directory,
// which Node's ESM loader refuses when the factory resolves the real module — the main app's
// suites mock this package the same way.
vi.mock('@civitai/client', () => ({
  Air: { isAir: () => false, stringify: vi.fn() },
  getResource: (...args: unknown[]) => getResource(...args),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
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

describe('keep-training currencies', () => {
  const sourceRun = {
    data: {
      steps: [
        {
          $type: 'training',
          input: { engine: 'ai-toolkit', ecosystem: 'sdxl', epochs: 10, steps: 2000 },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  };
  const opts = { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 };

  it('charges the accounts the user picked, for both the quote and the submit', async () => {
    getWorkflow.mockResolvedValue(sourceRun);
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 1400 } } });
    await continueTrainingWhatIf(client, { ...opts, currencies: ['blue', 'green'] });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, { ...opts, currencies: ['blue', 'green'] });
    const [quoted, submitted] = submitWorkflow.mock.calls.slice(-2);
    expect(quoted![0].body.currencies).toEqual(['blue', 'green']);
    expect(submitted![0].body.currencies).toEqual(['blue', 'green']);
  });

  it('falls back to blue + yellow when none (or none valid) are sent', async () => {
    getWorkflow.mockResolvedValue(sourceRun);
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, { ...opts, currencies: ['red'] });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.currencies).toEqual(['blue', 'yellow']);
  });
});

describe('keep-training base model pin', () => {
  const illustrious = 'urn:air:sdxl:checkpoint:civitai:795765@889818';
  const source = (input: Record<string, unknown>) => ({
    data: {
      steps: [
        {
          $type: 'training',
          input: { engine: 'ai-toolkit', ecosystem: 'sdxl', epochs: 10, steps: 2000, ...input },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  });
  const opts = { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 };

  it("continues on the source run's pinned base, for both the quote and the submit", async () => {
    getWorkflow.mockResolvedValue(source({ model: illustrious }));
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 1400 } } });
    await continueTrainingWhatIf(client, opts);
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, opts);
    const [quoted, submitted] = submitWorkflow.mock.calls.slice(-2);
    expect(quoted![0].body.steps[0].input.model).toBe(illustrious);
    expect(submitted![0].body.steps[0].input.model).toBe(illustrious);
  });

  it('sends no model when the source run had no pin', async () => {
    getWorkflow.mockResolvedValue(source({}));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, opts);
    expect('model' in submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input).toBe(false);
  });
});

describe('custom base model', () => {
  const custom = 'urn:air:sdxl:checkpoint:civitai:1@2';

  it('trains an SDXL run on the pasted base', async () => {
    getResource.mockResolvedValueOnce({ data: { fileFormat: 'SafeTensor' } });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-custom' } });
    await submitTrainingBatch(client, [{ ...baseRun(), customModel: custom }]);
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.model).toBe(custom);
  });

  it('refuses a custom base on an ecosystem that would train on its official base instead', async () => {
    const calls = submitWorkflow.mock.calls.length;
    getResource.mockClear();
    await expect(
      submitTrainingBatch(client, [
        baseRun(),
        { ...baseRun(), ecosystem: 'mossImage', modelVariant: 'base', customModel: custom },
      ])
    ).rejects.toThrow(/runs\[1\]\.customModel/);
    expect(getResource).not.toHaveBeenCalled();
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});

describe('retired base', () => {
  const wan21 = cardByType('wan')!.versions.find((v) => v.modelVariant === '2.1')!;
  const hunyuan = cardByType('hunyuan')!.versions[0]!;
  const wanRun = (model: string): TrainingRunInput => ({
    ...baseRun(),
    ecosystem: 'wan',
    modelVariant: '2.1',
    model,
  });

  it('refuses a run on the Hunyuan base, which the orchestrator trains as Wan 2.1', async () => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(submitTrainingBatch(client, [wanRun(hunyuan.air)])).rejects.toThrow(
      /runs\[0\]\.model/
    );
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('still submits a Wan 2.1 run', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-wan' } });
    await submitTrainingBatch(client, [wanRun(wan21.air)]);
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.model).toBe(wan21.air);
  });
});
