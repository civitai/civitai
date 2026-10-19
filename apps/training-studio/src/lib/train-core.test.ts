import { describe, expect, it, vi } from 'vitest';
import {
  continueTraining,
  continueTrainingWhatIf,
  submitTraining,
  submitTrainingBatch,
  TrainingTextRefusedError,
  type TrainingRunInput,
} from './train-core';

const submitWorkflow = vi.fn();
const getWorkflow = vi.fn();
// Hand-listed rather than spread over importOriginal: @civitai/client's dist imports a directory,
// which Node's ESM loader refuses when the factory resolves the real module — the main app's
// suites mock this package the same way.
vi.mock('@civitai/client', () => ({
  Air: { isAir: () => false, stringify: vi.fn() },
  getResource: vi.fn(),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
  updateWorkflow: vi.fn(),
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
}));

const client = {} as Parameters<typeof submitTraining>[0];
const checkText = async () => undefined;

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
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), keepTokens: 1.5 }], { checkText })
    ).rejects.toThrow(/keepTokens must be an integer/);
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), minSnrGamma: -1 }], { checkText })
    ).rejects.toThrow(/minSnrGamma must be a non-negative number/);
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), shuffleTokens: 'yes' as unknown as boolean }], {
        checkText,
      })
    ).rejects.toThrow(/shuffleTokens must be a boolean/);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});

describe('the training text check', () => {
  it('checks every run, trigger word and raw captions, before submitting any', async () => {
    const events: unknown[] = [];
    const check = async (input: unknown) => void events.push(input);
    const second = { ...baseRun(), trigger: 'other' };
    submitWorkflow
      .mockImplementationOnce(async () => (events.push('submit'), { data: { id: 'wf-3' } }))
      .mockImplementationOnce(async () => (events.push('submit'), { data: { id: 'wf-4' } }));
    await submitTrainingBatch(client, [baseRun(), second], { checkText: check });

    expect(events).toEqual([
      { triggerWord: baseRun().trigger, captions: baseRun().items.map((i) => i.caption) },
      { triggerWord: 'other', captions: second.items.map((i) => i.caption) },
      'submit',
      'submit',
    ]);
  });

  it('checks a dataset repeated across a sweep once', async () => {
    const check = vi.fn(async () => undefined);
    submitWorkflow
      .mockResolvedValueOnce({ data: { id: 'wf-5' } })
      .mockResolvedValueOnce({ data: { id: 'wf-6' } });
    await submitTrainingBatch(client, [baseRun(), { ...baseRun(), steps: 999 }], {
      checkText: check,
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a refused run stops the whole batch, so nothing is charged', async () => {
    const calls = submitWorkflow.mock.calls.length;
    const refuse = vi.fn(async ({ triggerWord }: { triggerWord: string }) => {
      if (triggerWord === 'bad') throw new TrainingTextRefusedError('blocked');
    });
    await expect(
      submitTrainingBatch(client, [baseRun(), { ...baseRun(), trigger: 'bad' }], {
        checkText: refuse,
      })
    ).rejects.toBeInstanceOf(TrainingTextRefusedError);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});

describe('keep-training currencies', () => {
  const sourceRun = {
    data: {
      steps: [
        {
          $type: 'training',
          input: {
            engine: 'ai-toolkit',
            ecosystem: 'sdxl',
            epochs: 10,
            steps: 2000,
            trainingData: { type: 'blobs', items: [] },
          },
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
    await continueTraining(client, { ...opts, currencies: ['blue', 'green'] }, { checkText });
    const [quoted, submitted] = submitWorkflow.mock.calls.slice(-2);
    expect(quoted![0].body.currencies).toEqual(['blue', 'green']);
    expect(submitted![0].body.currencies).toEqual(['blue', 'green']);
  });

  it('checks the source run text again, and submits nothing when it is refused', async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            ...sourceRun.data.steps[0],
            input: {
              ...sourceRun.data.steps[0].input,
              triggerWord: 'mystyle',
              trainingData: { type: 'blobs', items: [{ air: 'a', caption: 'a cat' }] },
            },
          },
        ],
      },
    });
    const calls = submitWorkflow.mock.calls.length;
    const refuse = vi.fn(async () => {
      throw new TrainingTextRefusedError('blocked');
    });
    await expect(continueTraining(client, opts, { checkText: refuse })).rejects.toBeInstanceOf(
      TrainingTextRefusedError
    );
    expect(refuse).toHaveBeenCalledWith({ triggerWord: 'mystyle', captions: ['a cat'] });
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('refuses to continue a run whose dataset text cannot be read back', async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            ...sourceRun.data.steps[0],
            input: {
              ...sourceRun.data.steps[0].input,
              trainingData: { type: 'zip', sourceUrl: 'x' },
            },
          },
        ],
      },
    });
    const calls = submitWorkflow.mock.calls.length;
    const check = vi.fn(async () => undefined);
    await expect(continueTraining(client, opts, { checkText: check })).rejects.toBeInstanceOf(
      TrainingTextRefusedError
    );
    expect(check).not.toHaveBeenCalled();
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('falls back to blue + yellow when none (or none valid) are sent', async () => {
    getWorkflow.mockResolvedValue(sourceRun);
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, { ...opts, currencies: ['red'] }, { checkText });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.currencies).toEqual(['blue', 'yellow']);
  });
});
