import { describe, expect, it, vi } from 'vitest';
import { trainingWhatIf } from './orchestrator-core';
import { buildKohyaInput } from './kohya-training';
import { cardByType } from '$lib/data/trainingModels';
import { parseServiceStatus } from '$lib/service-status-core';
import {
  FILES_PROCESSING_MESSAGE,
  FILES_PROCESSING_PARTIAL_REASON,
  FilesProcessingError,
} from '$lib/files-processing';
import {
  continueTraining,
  continueTrainingWhatIf,
  countDatasetMature,
  KOHYA_UNAVAILABLE,
  MatureAckRequiredError,
  submitTraining,
  submitTrainingBatch,
  TrainingBatchValidationError,
  TrainingSubmitError,
  TrainingTextRefusedError,
  trainingDataReady,
  type TrainingRunInput,
  type TrainingTextCheck,
} from './train-core';
import type { DatasetRating, StoredRating } from './dataset-rating';

const submitWorkflow = vi.fn();
const getWorkflow = vi.fn();
const getResource = vi.fn();
const headBlob = vi.fn();
// Hand-listed rather than spread over importOriginal: @civitai/orchestration-client's dist imports a directory,
// which Node's ESM loader refuses when the factory resolves the real module — the main app's
// suites mock this package the same way.
vi.mock('@civitai/orchestration-client', () => ({
  Air: {
    isAir: () => false,
    parseSafe: (air: string) => {
      const match = /^urn:air:([^:]+):([^:]+):([^:]+):(.+)$/.exec(air);
      return match
        ? { ecosystem: match[1], type: match[2], source: match[3], id: match[4] }
        : undefined;
    },
    stringify: (p: Record<string, string>) =>
      `urn:air:${p.ecosystem}:${p.type}:${p.source}:${p.id}@${p.version}`,
  },
  getResource: (...args: unknown[]) => getResource(...args),
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
  updateWorkflow: vi.fn(),
  submitWorkflow: (...args: unknown[]) => submitWorkflow(...args),
  headBlob: (...args: unknown[]) => headBlob(...args),
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

describe('the trigger word check', () => {
  it("checks every run's trigger word before submitting any", async () => {
    const events: unknown[] = [];
    const check = async (input: unknown) => void events.push(input);
    const second = { ...baseRun(), trigger: 'other' };
    submitWorkflow
      .mockImplementationOnce(async () => (events.push('submit'), { data: { id: 'wf-3' } }))
      .mockImplementationOnce(async () => (events.push('submit'), { data: { id: 'wf-4' } }));
    await submitTrainingBatch(client, [baseRun(), second], { checkText: check });

    expect(events).toEqual([
      { triggerWord: baseRun().trigger },
      { triggerWord: 'other' },
      'submit',
      'submit',
    ]);
  });

  it('checks a trigger word repeated across a sweep once', async () => {
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
    const refuse = vi.fn(async (input: Parameters<TrainingTextCheck>[0]) => {
      if ('triggerWord' in input && input.triggerWord === 'bad')
        throw new TrainingTextRefusedError('blocked');
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
    await continueTraining(client, { ...opts, currencies: ['blue', 'green'] }, { checkText });
    const [quoted, submitted] = submitWorkflow.mock.calls.slice(-2);
    expect(quoted![0].body.currencies).toEqual(['blue', 'green']);
    expect(submitted![0].body.currencies).toEqual(['blue', 'green']);
  });

  it("checks the source run's trigger word again, and submits nothing when it is refused", async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            ...sourceRun.data.steps[0],
            input: {
              ...sourceRun.data.steps[0].input,
              triggerWord: 'mystyle',
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
    expect(refuse).toHaveBeenCalledWith({ triggerWord: 'mystyle' });
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('a paid-only choice is charged in the paid account only, for both the quote and the submit', async () => {
    getWorkflow.mockResolvedValue(sourceRun);
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 1400 } } });
    await continueTrainingWhatIf(client, { ...opts, currencies: ['green'] });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, { ...opts, currencies: ['green'] }, { checkText });
    const [quoted, submitted] = submitWorkflow.mock.calls.slice(-2);
    expect(quoted![0].body.currencies).toEqual(['green']);
    expect(submitted![0].body.currencies).toEqual(['green']);
  });

  it('falls back to blue + yellow when none (or none valid) are sent', async () => {
    getWorkflow.mockResolvedValue(sourceRun);
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, { ...opts, currencies: ['red'] }, { checkText });
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
    await continueTraining(client, opts, { checkText });
    const [quoted, submitted] = submitWorkflow.mock.calls.slice(-2);
    expect(quoted![0].body.steps[0].input.model).toBe(illustrious);
    expect(submitted![0].body.steps[0].input.model).toBe(illustrious);
  });

  it('sends no model when the source run had no pin', async () => {
    getWorkflow.mockResolvedValue(source({}));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, opts, { checkText });
    expect('model' in submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input).toBe(false);
  });

  it("keeps an edit run's sample input images paired with its prompts", async () => {
    const samples = {
      prompts: ['ohwx, make it night'],
      sourceImages: ['https://orch.example/blobs/a.png'],
    };
    getWorkflow.mockResolvedValue(source({ ecosystem: 'flux2klein', samples }));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(client, opts, { checkText });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.samples).toEqual(samples);
  });
});

describe('keep-training checkpoint reference', () => {
  const source = (input: Record<string, unknown>) => ({
    data: {
      steps: [
        {
          $type: 'training',
          input: { engine: 'ai-toolkit', epochs: 10, steps: 2000, ...input },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  });
  const opts = { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 };

  it.each([
    ['mossImage', 'moss'],
    ['flux2klein', 'flux2'],
    ['flux3klein', 'flux3'],
    ['wan', 'wanvideo'],
    ['sdxl', 'sdxl'],
  ])(
    'names a %s checkpoint by the ecosystem the orchestrator checks it against',
    async (ecosystem, air) => {
      getWorkflow.mockResolvedValue(source({ ecosystem }));
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
      await continueTraining(client, opts, { checkText });
      expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.continueFrom).toBe(
        `urn:air:${air}:lora:orchestrator:blob@blob-10`
      );
    }
  );
});

describe('custom base model', () => {
  const custom = 'urn:air:sdxl:checkpoint:civitai:1@2';

  it('trains an SDXL run on the pasted base', async () => {
    getResource.mockResolvedValueOnce({ data: { fileFormat: 'SafeTensor' } });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-custom' } });
    await submitTrainingBatch(client, [{ ...baseRun(), customModel: custom }], { checkText });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.model).toBe(custom);
  });

  it('refuses a custom base on an ecosystem that would train on its official base instead', async () => {
    const calls = submitWorkflow.mock.calls.length;
    getResource.mockClear();
    await expect(
      submitTrainingBatch(
        client,
        [
          baseRun(),
          { ...baseRun(), ecosystem: 'mossImage', modelVariant: 'base', customModel: custom },
        ],
        { checkText }
      )
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
    await expect(submitTrainingBatch(client, [wanRun(hunyuan.air)], { checkText })).rejects.toThrow(
      /runs\[0\]\.model/
    );
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('still submits a Wan 2.1 run', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-wan' } });
    await submitTrainingBatch(client, [wanRun(wan21.air)], { checkText });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.model).toBe(wan21.air);
  });

  it('refuses an Ideogram 4 run that names no model, which would train on the ecosystem default', async () => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), ecosystem: 'ideogram4' }], { checkText })
    ).rejects.toThrow(/runs\[0\]\.ecosystem/);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('refuses to keep training an Ideogram 4 run, quote or submit', async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            $type: 'training',
            input: { engine: 'ai-toolkit', ecosystem: 'ideogram4', epochs: 10, steps: 2000 },
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    const calls = submitWorkflow.mock.calls.length;
    const opts = { workflowId: 'wf-id4', fromEpoch: 10, addEpochs: 5 };
    await expect(continueTrainingWhatIf(client, opts)).rejects.toThrow(/no longer offered/);
    await expect(continueTraining(client, opts, { checkText })).rejects.toThrow(
      /no longer offered/
    );
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  const wanSource = (model: string) => ({
    data: {
      steps: [
        {
          $type: 'training',
          input: {
            engine: 'ai-toolkit',
            ecosystem: 'wan',
            modelVariant: '2.1',
            model,
            epochs: 10,
            steps: 2000,
          },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  });
  const wanOpts = { workflowId: 'wf-wan-src', fromEpoch: 10, addEpochs: 5 };

  it('refuses to keep training a Hunyuan run, whose ecosystem (wan) is still offered', async () => {
    getWorkflow.mockResolvedValue(wanSource(hunyuan.air));
    const calls = submitWorkflow.mock.calls.length;
    await expect(continueTrainingWhatIf(client, wanOpts)).rejects.toThrow(/no longer offered/);
    await expect(continueTraining(client, wanOpts, { checkText })).rejects.toThrow(
      /no longer offered/
    );
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('still keeps training a Wan 2.1 run', async () => {
    getWorkflow.mockResolvedValue(wanSource(wan21.air));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-wan-next' } });
    await continueTraining(client, wanOpts, { checkText });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.model).toBe(wan21.air);
  });
});

describe('sample input images', () => {
  const kleinRun = (): TrainingRunInput => ({
    ...baseRun(),
    ecosystem: 'flux2klein',
    modelVariant: '9b',
    prompts: ['ohwx, make it night', 'ohwx, add snow'],
  });
  const images = ['https://orch.example/blobs/a.png', 'https://orch.example/blobs/b.png'];

  it('sends them on the samples, beside the prompts they pair with', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-edit' } });
    await submitTrainingBatch(client, [{ ...kleinRun(), sourceImages: images }], { checkText });
    expect(submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.samples).toEqual({
      prompts: ['ohwx, make it night', 'ohwx, add snow'],
      sourceImages: images,
    });
  });

  it('sends no sourceImages key on a text-only run', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-text' } });
    await submitTraining(client, kleinRun());
    const samples = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.samples;
    expect('sourceImages' in samples).toBe(false);
  });

  it('refuses images a run cannot use, or that do not pair one-to-one, before submitting', async () => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), sourceImages: [images[0]!] }], { checkText })
    ).rejects.toThrow(/runs\[0\]\.sourceImages are not supported for this model/);
    await expect(
      submitTrainingBatch(client, [{ ...kleinRun(), sourceImages: [images[0]!] }], { checkText })
    ).rejects.toThrow(/runs\[0\]\.sourceImages must have one image per sample prompt/);
    await expect(
      submitTrainingBatch(client, [{ ...kleinRun(), sourceImages: [images[0]!, ''] }], {
        checkText,
      })
    ).rejects.toThrow(/runs\[0\]\.sourceImages must be an array of image URLs/);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});

describe('edit LoRA pairs', () => {
  const pair = (n: string, instruction = 'add a smiley') => [
    { air: `blob-start-${n}`, caption: '', path: `control_1/pair_${n}.png` },
    { air: `blob-result-${n}`, caption: instruction, path: `main/pair_${n}.jpg` },
  ];
  const editRun = (): TrainingRunInput => ({
    ...baseRun(),
    ecosystem: 'flux2klein',
    modelVariant: '9b',
    editTraining: true,
    items: [...pair('0001'), ...pair('0002')],
  });

  it('sends the pairs as blobs placed by path, flagged as edit training', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-pairs' } });
    await submitTrainingBatch(client, [editRun()], { checkText });
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect(input.trainingData).toEqual({ type: 'blobs', items: editRun().items });
    expect(input.isEditTraining).toBe(true);
  });

  it('keeps a starting image shared by two pairs once per pair', async () => {
    const shared = [
      ...pair('0001'),
      { air: 'blob-start-0001', caption: '', path: 'control_1/pair_0002.png' },
      { air: 'blob-result-0002', caption: 'add a hat', path: 'main/pair_0002.png' },
    ];
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-shared' } });
    await submitTraining(client, { ...editRun(), items: shared });
    expect(
      submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input.trainingData.items
    ).toHaveLength(4);
  });

  it('never flags a plain dataset as edit training', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-plain' } });
    await submitTraining(client, { ...editRun(), editTraining: undefined, items: baseRun().items });
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect('isEditTraining' in input).toBe(false);
  });

  it.each([
    ['on a model without edit training', { ecosystem: 'sdxl' }, /editTraining is not supported/],
    [
      'with a result missing its start',
      { items: [pair('0001')[1]!] },
      /pair pair_0001 is missing an image/,
    ],
    [
      'with a start missing its result',
      { items: [pair('0001')[0]!] },
      /pair pair_0001 is missing an image/,
    ],
    [
      'with a result missing its instruction',
      { items: pair('0001', ' ') },
      /caption must hold the instruction/,
    ],
    [
      'with a path outside the two folders',
      { items: [{ air: 'b', caption: 'x', path: 'control_2/pair_0001.png' }, ...pair('0001')] },
      /path must be control_1\/<name> or main\/<name>/,
    ],
    [
      'with paths on a plain dataset',
      { editTraining: false },
      /carry a path only for edit training/,
    ],
  ])('refuses pairs %s, before submitting', async (_label, over, error) => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(
      submitTrainingBatch(client, [{ ...editRun(), ...over } as TrainingRunInput], { checkText })
    ).rejects.toThrow(error);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('keeps training a pair dataset as an edit LoRA', async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            $type: 'training',
            input: {
              engine: 'ai-toolkit',
              ecosystem: 'flux2klein',
              epochs: 10,
              steps: 2000,
              isEditTraining: true,
              trainingData: { type: 'blobs', items: pair('0001') },
            },
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    await continueTraining(
      client,
      { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 },
      { checkText }
    );
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect(input.isEditTraining).toBe(true);
    expect(input.trainingData.items).toEqual(pair('0001'));
  });
});

describe('Prodigy learning rate', () => {
  // Prodigy finds its own step size and expects lr 1; the orchestrator refuses lr >= 0.1 for
  // anything else. The main trainer couples the two the same way.
  it('sends lr 1 for a Prodigy run, whatever the run carries', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-prodigy' } });
    await submitTraining(client, { ...baseRun(), optimizer: 'Prodigy' });
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect(input).toMatchObject({ optimizerType: 'prodigy', lr: 1, textEncoderLr: 1 });
    expect(input.trainTextEncoder).toBe(true);
  });

  it('keeps the text encoder off for a Prodigy run that does not train it', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-prodigy-te-off' } });
    await submitTraining(client, { ...baseRun(), optimizer: 'Prodigy', textEncoderLr: 0 });
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect(input).toMatchObject({ lr: 1, textEncoderLr: 0, trainTextEncoder: false });
  });

  it('leaves the rate alone for other optimizers', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-adafactor' } });
    await submitTraining(client, baseRun());
    const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect(input).toMatchObject({ lr: 5e-4, textEncoderLr: 5e-5 });
  });

  it('refuses a Prodigy-level rate on another optimizer before anything is submitted', async () => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), unetLr: 1 }], { checkText })
    ).rejects.toThrow(/unetLr must be less than 0.1 for non-Prodigy optimizers/);
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), textEncoderLr: 0.1 }], { checkText })
    ).rejects.toThrow(/textEncoderLr must be less than 0.1 for non-Prodigy optimizers/);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});

describe('text encoder on a model that cannot train it', () => {
  const lastInput = () => submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
  const sourceRun = (ecosystem: string) => ({
    data: {
      steps: [
        {
          $type: 'training',
          input: {
            engine: 'ai-toolkit',
            ecosystem,
            epochs: 10,
            steps: 1500,
            textEncoderLr: 1e-4,
            trainTextEncoder: true,
          },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  });
  const continueOpts = { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 };

  // One ecosystem per class the in-app trainer locks; flux2klein also carries the Studio-only edit cards.
  describe.each([
    'anima',
    'krea2',
    'flux1',
    'flux2klein',
    'qwen',
    'zimageturbo',
    'boogu',
    'wan',
    'ltx2',
  ])('%s', (ecosystem) => {
    it('sends the text encoder off, whatever rate the run carries', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-locked' } });
      await submitTraining(client, { ...baseRun(), ecosystem, textEncoderLr: 1e-4 });
      expect(lastInput()).toMatchObject({ textEncoderLr: 0, trainTextEncoder: false });
    });

    it('keeps it off under Prodigy', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-locked-prodigy' } });
      await submitTraining(client, { ...baseRun(), ecosystem, optimizer: 'Prodigy' });
      expect(lastInput()).toMatchObject({ lr: 1, textEncoderLr: 0, trainTextEncoder: false });
    });

    it('accepts a stale Prodigy-level rate rather than refusing it', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-locked-stale' } });
      await submitTrainingBatch(client, [{ ...baseRun(), ecosystem, textEncoderLr: 1 }], {
        checkText,
      });
      expect(lastInput()).toMatchObject({ textEncoderLr: 0, trainTextEncoder: false });
    });

    it('turns it off when continuing a run submitted with it on', async () => {
      getWorkflow.mockResolvedValueOnce(sourceRun(ecosystem));
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-locked-next' } });
      await continueTraining(client, continueOpts, { checkText });
      expect(lastInput()).toMatchObject({ textEncoderLr: 0, trainTextEncoder: false });
    });
  });

  it.each(['mossImage', 'flux3klein'])(
    'leaves a default-off ecosystem the user turned on alone (%s)',
    async (ecosystem) => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-default-off' } });
      await submitTraining(client, { ...baseRun(), ecosystem, textEncoderLr: 1e-4 });
      expect(lastInput()).toMatchObject({ textEncoderLr: 1e-4, trainTextEncoder: true });
    }
  );

  it('still trains the text encoder on a model that supports it', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-sdxl-te' } });
    await submitTraining(client, { ...baseRun(), textEncoderLr: 1e-4 });
    expect(lastInput()).toMatchObject({ textEncoderLr: 1e-4, trainTextEncoder: true });
  });

  it('keeps the text encoder on when continuing a model that supports it', async () => {
    getWorkflow.mockResolvedValueOnce(sourceRun('sdxl'));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-sdxl-next' } });
    await continueTraining(client, continueOpts, { checkText });
    expect(lastInput()).toMatchObject({ textEncoderLr: 1e-4, trainTextEncoder: true });
  });
});

// Mature training data is charged in Yellow only after the user confirms: every body is `manual`, and only a
// confirmed mature run carries the unlock.
describe('mature charge: Yellow only after the user confirms', () => {
  const nsfwHead = (level: string | null) => ({
    response: new Response(null, {
      status: 204,
      headers: level ? { 'X-NSFW-Level': level } : {},
    }),
  });
  const matureSource = (id: string, meta: Record<string, unknown> = {}) => ({
    data: {
      id,
      metadata: meta,
      steps: [
        {
          $type: 'training',
          input: {
            engine: 'ai-toolkit',
            ecosystem: 'sdxl',
            epochs: 10,
            steps: 2000,
            trainingData: {
              type: 'blobs',
              items: [
                { air: 'urn:air:other:blob:civitai:blob@safe-1', caption: 'a' },
                { air: 'urn:air:other:blob:civitai:blob@spicy-2', caption: 'b' },
              ],
            },
          },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  });
  const rateSpicy = (args: { path: { blobId: string } }) =>
    Promise.resolve(nsfwHead(args.path.blobId === 'spicy-2' ? 'R' : 'PG'));

  describe('fresh submit', () => {
    it('a non-mature run: manual, no unlock, and the currencies the user picked (unchanged)', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-a' } });
      await submitTraining(client, { ...baseRun(), currencies: ['blue', 'green'] });
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.upgradeMode).toBe('manual');
      expect('allowMatureContent' in body).toBe(false);
      expect(body.currencies).toEqual(['blue', 'green']);
    });

    it('a non-mature run with no pick still falls back to blue + yellow', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-b' } });
      await submitTraining(client, baseRun());
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.upgradeMode).toBe('manual');
      expect('allowMatureContent' in body).toBe(false);
      expect(body.currencies).toEqual(['blue', 'yellow']);
    });

    it('an acked mature run unlocks at submit and is charged from Blue + Yellow, never Green', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-c' } });
      await submitTraining(client, {
        ...baseRun(),
        currencies: ['blue', 'green'],
        matureAck: true,
      });
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.upgradeMode).toBe('manual');
      expect(body.allowMatureContent).toBe(true);
      expect(body.currencies).toEqual(['blue', 'yellow']);
    });

    it('a paid-only mature run is charged in Yellow only — no Blue, never Green', async () => {
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-c2' } });
      await submitTraining(client, { ...baseRun(), currencies: ['green'], matureAck: true });
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.allowMatureContent).toBe(true);
      expect(body.currencies).toEqual(['yellow']);
    });

    it('refuses an unconfirmed mature dataset before anything is charged, rating a sweep once', async () => {
      headBlob.mockReset();
      headBlob.mockImplementation(rateSpicy);
      const before = submitWorkflow.mock.calls.length;
      const items = [
        { air: 'urn:air:other:blob:civitai:blob@safe-1', caption: 'a' },
        { air: 'urn:air:other:blob:civitai:blob@spicy-2', caption: 'b' },
      ];
      await expect(
        submitTrainingBatch(
          client,
          [
            { ...baseRun(), items },
            { ...baseRun(), epochs: 12, items },
          ],
          { checkText }
        )
      ).rejects.toBeInstanceOf(MatureAckRequiredError);
      expect(submitWorkflow.mock.calls.length).toBe(before);
      expect(headBlob).toHaveBeenCalledTimes(2);
      for (const [args] of headBlob.mock.calls) expect(args.query?.workflowId).toBeUndefined();
    });

    it('submits a confirmed mature sweep without re-rating it', async () => {
      headBlob.mockReset();
      submitWorkflow
        .mockResolvedValueOnce({ data: { id: 'wf-s1' } })
        .mockResolvedValueOnce({ data: { id: 'wf-s2' } });
      const { workflowIds } = await submitTrainingBatch(
        client,
        [
          { ...baseRun(), matureAck: true },
          { ...baseRun(), epochs: 12, matureAck: true },
        ],
        { checkText }
      );
      expect(workflowIds).toEqual(['wf-s1', 'wf-s2']);
      expect(headBlob).not.toHaveBeenCalled();
    });

    it('refuses a non-boolean ack before anything is submitted', async () => {
      const before = submitWorkflow.mock.calls.length;
      await expect(
        submitTrainingBatch(client, [{ ...baseRun(), matureAck: 'yes' as unknown as boolean }], {
          checkText,
        })
      ).rejects.toThrow(/matureAck/);
      expect(submitWorkflow.mock.calls.length).toBe(before);
    });

    it('names Yellow when an acked mature run is short of it', async () => {
      submitWorkflow.mockResolvedValueOnce({
        error: { detail: 'insufficientBuzz' },
        response: { status: 400 },
      });
      await expect(submitTraining(client, { ...baseRun(), matureAck: true })).rejects.toThrow(
        /Yellow/
      );
    });
  });

  describe('train further', () => {
    const opts = { fromEpoch: 10, addEpochs: 5, currencies: ['blue', 'green'] };

    it('quotes a mature source with its mature count, on a manual body with no unlock', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-q1'));
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      const quote = await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-q1' });
      expect(quote.matureCount).toBe(1);
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.upgradeMode).toBe('manual');
      expect('allowMatureContent' in body).toBe(false);
    });

    it('refuses a mature source without the ack, and submits nothing', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-r1'));
      headBlob.mockImplementation(rateSpicy);
      const before = submitWorkflow.mock.calls.length;
      await expect(
        continueTraining(client, { ...opts, workflowId: 'wf-r1' }, { checkText })
      ).rejects.toBeInstanceOf(MatureAckRequiredError);
      expect(submitWorkflow.mock.calls.length).toBe(before);
    });

    it('with the ack, unlocks at submit and charges Blue + Yellow, never Green', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-r2'));
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
      await continueTraining(
        client,
        { ...opts, workflowId: 'wf-r2', matureAck: true },
        { checkText }
      );
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.upgradeMode).toBe('manual');
      expect(body.allowMatureContent).toBe(true);
      expect(body.currencies).toEqual(['blue', 'yellow']);
      expect(body.metadata.matureCount).toBe(1);
    });

    it('a paid-only mature continuation is charged in Yellow only — no Blue, never Green', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-r3'));
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
      await continueTraining(
        client,
        { ...opts, workflowId: 'wf-r3', currencies: ['green'], matureAck: true },
        { checkText }
      );
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.allowMatureContent).toBe(true);
      expect(body.currencies).toEqual(['yellow']);
    });

    it('a non-mature source: manual, no unlock, currencies unchanged, ack or not', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-n1'));
      headBlob.mockImplementation(() => Promise.resolve(nsfwHead('PG13')));
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
      await continueTraining(
        client,
        { ...opts, workflowId: 'wf-n1', matureAck: true },
        { checkText }
      );
      const body = submitWorkflow.mock.calls.at(-1)![0].body;
      expect(body.upgradeMode).toBe('manual');
      expect('allowMatureContent' in body).toBe(false);
      expect(body.currencies).toEqual(['blue', 'green']);
    });

    it('rates the dataset with a HEAD that never carries a workflowId', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-h1'));
      headBlob.mockReset();
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-h1' });
      expect(headBlob).toHaveBeenCalledTimes(2);
      for (const [args] of headBlob.mock.calls) {
        expect(JSON.stringify(args)).not.toMatch(/workflowId/i);
        expect(args.query?.workflowId).toBeUndefined();
      }
      expect(headBlob.mock.calls.map(([a]) => a.path.blobId).sort()).toEqual(['safe-1', 'spicy-2']);
    });

    it('rates a source once per page: the quote and the submit share the probe', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-c1'));
      headBlob.mockReset();
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-c1' });
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
      await continueTraining(
        client,
        { ...opts, workflowId: 'wf-c1', matureAck: true },
        { checkText }
      );
      expect(headBlob).toHaveBeenCalledTimes(2);
    });

    it('ignores an ack on the quote: it is priced without the unlock', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-qa'));
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-qa', matureAck: true });
      expect('allowMatureContent' in submitWorkflow.mock.calls.at(-1)![0].body).toBe(false);
    });

    it('names Yellow when a confirmed continuation is short of it', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-y1'));
      headBlob.mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValueOnce({
        error: { detail: 'insufficientBuzz' },
        response: { status: 400 },
      });
      await expect(
        continueTraining(client, { ...opts, workflowId: 'wf-y1', matureAck: true }, { checkText })
      ).rejects.toThrow(/Yellow/);
    });

    it('rates the dataset again after a probe with a failed HEAD', async () => {
      getWorkflow.mockResolvedValue(matureSource('wf-f1'));
      headBlob.mockReset();
      headBlob.mockRejectedValueOnce(new Error('network')).mockImplementation(rateSpicy);
      submitWorkflow.mockResolvedValue({ data: { cost: { total: 900 } } });
      await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-f1' });
      const again = await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-f1' });
      expect(again.matureCount).toBe(1);
      expect(headBlob).toHaveBeenCalledTimes(4);
      submitWorkflow.mockReset();
    });

    it("trusts a source's stamped mature count without probing, but probes when it says 0", async () => {
      headBlob.mockReset();
      headBlob.mockImplementation(rateSpicy);
      getWorkflow.mockResolvedValue(matureSource('wf-m1', { matureCount: 3 }));
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      const stamped = await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-m1' });
      expect(stamped.matureCount).toBe(3);
      expect(headBlob).not.toHaveBeenCalled();

      getWorkflow.mockResolvedValue(matureSource('wf-m0', { matureCount: 0 }));
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      const probed = await continueTrainingWhatIf(client, { ...opts, workflowId: 'wf-m0' });
      expect(probed.matureCount).toBe(1);
      expect(headBlob).toHaveBeenCalledTimes(2);
    });
  });
});

describe('a model that is down', () => {
  const krea2 = cardByType('krea2')!.versions[0]!;
  const krea2Run = (): TrainingRunInput => ({ ...baseRun(), ecosystem: krea2.ecosystem });
  const down = (reason?: unknown) =>
    parseServiceStatus({
      available: true,
      blockedModels: [krea2.key],
      blockedModelReasons: reason === undefined ? undefined : { [krea2.key]: reason },
    });
  const orchestratorCalls = () =>
    [submitWorkflow, getWorkflow, getResource, headBlob].reduce(
      (n, f) => n + f.mock.calls.length,
      0
    );

  it('refuses the batch before any orchestrator call or trigger word check, with the reason', async () => {
    vi.clearAllMocks();
    const check = vi.fn(async () => undefined);
    await expect(
      submitTrainingBatch(client, [baseRun(), krea2Run()], {
        checkText: check,
        status: down('The provider is down.'),
      })
    ).rejects.toThrow('Krea 2 is temporarily unavailable for training. The provider is down.');
    expect(orchestratorCalls()).toBe(0);
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses without a note when the reason is missing or not text', async () => {
    for (const status of [down(), down(42), down('   ')])
      await expect(
        submitTrainingBatch(client, [krea2Run()], { checkText, status })
      ).rejects.toThrow(/^Krea 2 is temporarily unavailable for training\.$/);
  });

  it('refuses keep-training on it, quote and submit, before anything is charged', async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            $type: 'training',
            input: { engine: 'ai-toolkit', ecosystem: krea2.ecosystem, epochs: 10, steps: 2000 },
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    submitWorkflow.mockClear();
    const opts = { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 };
    await expect(continueTrainingWhatIf(client, opts, { status: down() })).rejects.toThrow(
      /Krea 2 is temporarily unavailable/
    );
    await expect(continueTraining(client, opts, { checkText, status: down() })).rejects.toThrow(
      /Krea 2 is temporarily unavailable/
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('still submits other models, and Krea 2 once it is unblocked', async () => {
    submitWorkflow.mockResolvedValue({ data: { id: 'wf-ok' } });
    await submitTrainingBatch(client, [baseRun()], { checkText, status: down() });
    await submitTrainingBatch(client, [krea2Run()], {
      checkText,
      status: parseServiceStatus({ available: true, blockedModels: [] }),
    });
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
    submitWorkflow.mockReset();
  });

  it('fails open on a malformed status', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-ok' } });
    const status = parseServiceStatus({ blockedModels: 'krea2', blockedModelReasons: [1] });
    await submitTrainingBatch(client, [krea2Run()], { checkText, status });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('keep-training a custom-base run while a sibling model is down', () => {
  const customAir = 'urn:air:sdxl:checkpoint:civitai:12345@67890';
  const source = {
    data: {
      steps: [
        {
          $type: 'training',
          input: {
            engine: 'ai-toolkit',
            ecosystem: 'sdxl',
            epochs: 10,
            steps: 2000,
            model: customAir,
          },
          output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
        },
      ],
    },
  };
  const opts = { workflowId: 'wf-src', fromEpoch: 10, addEpochs: 5 };

  it('is not refused for one blocked sibling in the ecosystem', async () => {
    getWorkflow.mockResolvedValue(source);
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-next' } });
    const status = parseServiceStatus({ blockedModels: ['pony'] });
    await expect(continueTraining(client, opts, { checkText, status })).resolves.toBe('wf-next');
  });

  it('is refused when its custom base itself is blocked', async () => {
    getWorkflow.mockResolvedValue(source);
    const status = parseServiceStatus({ blockedModels: [customAir] });
    await expect(continueTraining(client, opts, { checkText, status })).rejects.toThrow(
      'This custom model is blocked from training. Pick another.'
    );
  });
});

describe('the checkpoint a run actually trains', () => {
  it('refuses a run naming no base when its ecosystem default (SDXL 1.0) is blocked', async () => {
    submitWorkflow.mockClear();
    const status = parseServiceStatus({ blockedModels: ['sdxl'] });
    await expect(submitTrainingBatch(client, [baseRun()], { checkText, status })).rejects.toThrow(
      /^SDXL.* is temporarily unavailable for training\.$/
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lets a run pinned to a sibling base through while the default is blocked', async () => {
    const illustrious = cardByType('illustrious')!.versions[0]!;
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-ill' } });
    const status = parseServiceStatus({ blockedModels: ['sdxl'] });
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), model: illustrious.air }], { checkText, status })
    ).resolves.toEqual({ workflowIds: ['wf-ill'] });
  });

  it('checks a custom base by its own AIR, even when the base it overrides is blocked', async () => {
    const customAir = 'urn:air:sdxl:checkpoint:civitai:12345@67890';
    getResource.mockResolvedValueOnce({ data: { fileFormat: 'SafeTensor' } });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-custom' } });
    const blockedBase = parseServiceStatus({ blockedModels: ['sdxl'] });
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), customModel: customAir }], {
        checkText,
        status: blockedBase,
      })
    ).resolves.toEqual({ workflowIds: ['wf-custom'] });
    await expect(
      submitTrainingBatch(client, [{ ...baseRun(), customModel: customAir }], {
        checkText,
        status: parseServiceStatus({ blockedModels: [customAir] }),
      })
    ).rejects.toThrow('This custom model is blocked from training. Pick another.');
  });
});

describe('Kohya training', () => {
  const model = 'urn:air:sdxl:checkpoint:civitai:795765@889818';
  const run = (): TrainingRunInput => ({
    ...baseRun(),
    engine: 'kohya',
    model,
    lrScheduler: 'cosine_with_restarts',
    negativePrompt: 'blurry',
    items: [
      { air: 'blob-1', caption: '1girl' },
      { air: 'blob-2', caption: 'OHWX, portrait' },
    ],
    kohya: {
      numRepeats: 20,
      enableBucket: false,
      lrSchedulerNumCycles: 4,
      vParameterization: true,
      seed: 123,
    },
    shuffleTokens: true,
    keepTokens: 1,
    noiseOffset: 0.03,
    minSnrGamma: 0,
  });

  it('quotes and submits the same config through the new training route', async () => {
    const config = run();
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 300 } } });
    await trainingWhatIf(client, { ...config, imageCount: 2 });
    const quoted = submitWorkflow.mock.calls.at(-1)![0].body.steps[0];
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-kohya' } });
    await submitTraining(client, config);
    const submitted = submitWorkflow.mock.calls.at(-1)![0].body.steps[0];
    const { trainingData: _data, samples: _samples, trace: _trace, ...quoteConfig } = quoted.input;
    const {
      trainingData,
      samples: _submittedSamples,
      trace: _submittedTrace,
      ...submitConfig
    } = submitted.input;
    expect(quoted.$type).toBe('training');
    expect(submitted.$type).toBe('training');
    expect(submitted.input.samples.negativePrompt).toBe('blurry');
    expect(quoteConfig).toEqual(submitConfig);
    expect(submitConfig).toMatchObject({
      engine: 'kohya',
      model,
      maxTrainEpochs: 10,
      steps: 2000,
      numRepeats: 20,
      trainBatchSize: 4,
      unetLR: 0.0005,
      textEncoderLR: 0.00005,
      trainTextEncoder: true,
      shuffleCaption: true,
      keepTokens: 1,
      lrSchedulerNumCycles: 4,
      vParameterization: true,
    });
    expect(trainingData.items.map((item: { caption: string }) => item.caption)).toEqual([
      'ohwx, 1girl',
      'OHWX, portrait',
    ]);
    for (const key of ['usesStepPricing', 'ecosystem', 'epochs', 'lr', 'batchSize', 'triggerWord'])
      expect(submitted.input).not.toHaveProperty(key);
    expect(config.items[0]!.caption).toBe('1girl');
  });

  it.each(['sd1', 'sdxl', 'pony', 'illustrious', 'noobai', 'flux1', 'chroma'])(
    'accepts an arbitrary compatible %s checkpoint',
    async (family) => {
      const ecosystem = ['pony', 'illustrious', 'noobai'].includes(family) ? 'sdxl' : family;
      getResource.mockResolvedValueOnce({ data: { fileFormat: 'SafeTensor' } });
      headBlob.mockResolvedValue({ data: {}, response: { ok: true } });
      submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-custom-kohya' } });
      const customModel = `urn:air:${family}:checkpoint:civitai:123@456`;
      await submitTrainingBatch(client, [{ ...run(), ecosystem, customModel }], {
        checkText,
        kohyaAllowed: true,
      });
      const input = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
      expect(input.model).toBe(customModel);
      if (family === 'flux1' || family === 'chroma') {
        expect(input).toMatchObject({
          noiseOffset: 0,
          minSnrGamma: 0,
          clipSkip: 1,
          fp8Base: true,
          blocksToSwap: 18,
        });
        expect(input).not.toHaveProperty('vParameterization');
      }
      if (family === 'chroma')
        expect(input).toMatchObject({ textEncoderLR: 0, trainTextEncoder: false });
    }
  );

  it.each([
    { batchSize: 10 },
    { epochs: 21 },
    { networkDim: 257 },
    { resolution: 1000 },
    { kohya: { numRepeats: 0 } },
    { kohya: { seed: -1 } },
    { minSnrGamma: 2.5 },
    { optimizer: 'Automagic' },
    { customModel: 'urn:air:flux1:checkpoint:civitai:1@2' },
    { customModel: 'urn:air:sdxl:lora:civitai:1@2' },
  ])('refuses invalid config before submission: %j', async (invalid) => {
    const calls = submitWorkflow.mock.calls.length;
    await expect(
      submitTrainingBatch(client, [{ ...run(), ...invalid }], { checkText, kohyaAllowed: true })
    ).rejects.toThrow();
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });

  it('leaves SDXL prediction mode to checkpoint metadata by default', () => {
    const input = buildKohyaInput({ ...run(), kohya: {} }, { type: 'blobs', items: [] }, 'none');
    expect(input).not.toHaveProperty('vParameterization');
    expect(input).not.toHaveProperty('zeroTerminalSnr');
  });

  it('preserves Kohya config and trigger checks when training further without echoing read-only fields', async () => {
    const input = buildKohyaInput(run(), { type: 'blobs', items: [] }, 'events');
    getWorkflow.mockResolvedValue({
      data: {
        metadata: { trigger: 'ohwx' },
        steps: [
          {
            $type: 'training',
            input: { ...input, usesStepPricing: true },
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    const opts = { workflowId: 'wf-kohya-source', fromEpoch: 10, addEpochs: 5 };
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 200 } } });
    await continueTrainingWhatIf(client, opts, { kohyaAllowed: true });
    const quoted = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-kohya-further' } });
    const check = vi.fn(async () => undefined);
    await continueTraining(client, opts, { checkText: check, kohyaAllowed: true });
    expect(check).toHaveBeenCalledWith({ triggerWord: 'ohwx' });
    const submitted = submitWorkflow.mock.calls.at(-1)![0].body.steps[0].input;
    expect(submitted).toEqual(quoted);
    expect(submitted).toMatchObject({
      ...input,
      maxTrainEpochs: 5,
      steps: 1000,
      continueFrom: 'urn:air:sdxl:lora:orchestrator:blob@blob-10',
    });
    expect(submitted).not.toHaveProperty('usesStepPricing');
    expect(submitted).not.toHaveProperty('ecosystem');
  });

  it('refuses a Kohya run, or a continuation or its quote, without the gate', async () => {
    getWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            $type: 'training',
            input: buildKohyaInput(run(), { type: 'blobs', items: [] }, 'none'),
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    const opts = { workflowId: 'wf-kohya-source', fromEpoch: 10, addEpochs: 5 };
    const calls = submitWorkflow.mock.calls.length;
    await expect(submitTrainingBatch(client, [run()], { checkText })).rejects.toThrow(
      KOHYA_UNAVAILABLE
    );
    await expect(continueTrainingWhatIf(client, opts)).rejects.toThrow(KOHYA_UNAVAILABLE);
    await expect(continueTraining(client, opts, { checkText })).rejects.toThrow(KOHYA_UNAVAILABLE);
    expect(submitWorkflow.mock.calls.length).toBe(calls);
  });
});

// The v2 rating replaces only the mature count: every refusal still applies, and any image it hasn't
// rated (or can't be trusted on) is counted from its upload rating, exactly as without it. The mature
// level is private flag state, so these run at every level rather than the deployed one.
describe('dataset maturity under the v2 rating', () => {
  const air = (id: string) => `urn:air:other:blob:civitai:blob@${id}`;
  const items = (...ids: string[]) => ids.map((id) => ({ air: air(id), caption: 'a' }));
  /** Every image's upload rating; `null` is a failed HEAD. */
  const uploadRatings = (levels: Record<string, string | null>) => {
    headBlob.mockReset();
    headBlob.mockImplementation(async ({ path }: { path: { blobId: string } }) => {
      const level = levels[path.blobId];
      return {
        response:
          level === null
            ? new Response(null, { status: 404 })
            : new Response(null, { status: 204, headers: level ? { 'X-NSFW-Level': level } : {} }),
      };
    });
  };
  const ratingAt = (
    matureLevel: number,
    stored: Record<string, StoredRating>,
    read?: DatasetRating['read']
  ): DatasetRating => ({
    matureLevel,
    read:
      read ?? (async (keys) => new Map(keys.flatMap((k) => (stored[k] ? [[k, stored[k]]] : [])))),
  });
  const submitWith = (rating: DatasetRating | undefined, run: Partial<TrainingRunInput>) =>
    submitTrainingBatch(client, [{ ...baseRun(), ...run }], { checkText, datasetRating: rating });
  const lastBody = () => submitWorkflow.mock.calls.at(-1)![0].body;

  describe.each([1, 2, 3, 4])('mature from level %i', (level) => {
    it('a clothed dataset the upload rating called mature, rated below the level, trains unconfirmed', async () => {
      uploadRatings({ 'outfit-1': 'R', 'outfit-2': 'X' });
      submitWorkflow.mockResolvedValueOnce({ data: { id: `wf-sfw-${level}` } });
      const rating = ratingAt(level, {
        'outfit-1': { s: level - 1, r: false },
        'outfit-2': { s: 0, r: false },
      });
      await submitWith(rating, { items: items('outfit-1', 'outfit-2') });
      expect('allowMatureContent' in lastBody()).toBe(false);
    });

    it('a nude image rated at the level still needs the confirm', async () => {
      uploadRatings({ 'nude-1': 'PG' });
      const calls = submitWorkflow.mock.calls.length;
      const rating = ratingAt(level, { 'nude-1': { s: level, r: false } });
      await expect(submitWith(rating, { items: items('nude-1') })).rejects.toMatchObject({
        matureCount: 1,
      });
      expect(submitWorkflow.mock.calls.length).toBe(calls);
    });

    it('a restricted image is mature whatever its level', async () => {
      uploadRatings({ 'r-1': 'PG' });
      const rating = ratingAt(level, { 'r-1': { s: 0, r: true } });
      await expect(submitWith(rating, { items: items('r-1') })).rejects.toBeInstanceOf(
        MatureAckRequiredError
      );
    });

    it('an unrated image is counted from its upload rating', async () => {
      uploadRatings({ 'rated-1': 'R', 'unrated-2': 'R' });
      const rating = ratingAt(level, { 'rated-1': { s: 0, r: false } });
      await expect(
        submitWith(rating, { items: items('rated-1', 'unrated-2') })
      ).rejects.toMatchObject({ matureCount: 1 });
    });
  });

  it('a cache that cannot be read counts every image from its upload rating', async () => {
    uploadRatings({ 'a-1': 'R', 'a-2': 'PG' });
    const rating = ratingAt(1, {}, async () => {
      throw new Error('redis down');
    });
    await expect(submitWith(rating, { items: items('a-1', 'a-2') })).rejects.toMatchObject({
      matureCount: 1,
    });
  });

  it("never uses a stored rating for a blob this caller's HEAD could not read", async () => {
    uploadRatings({ 'theirs-1': null });
    const read = vi.fn(async () => new Map([['theirs-1', { s: 4, r: true }]]));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-theirs' } });
    // Counted as the upload path counts a failed HEAD (not mature), not by the shared cache's entry.
    await submitWith(ratingAt(1, {}, read), { items: items('theirs-1') });
    expect('allowMatureContent' in lastBody()).toBe(false);
  });

  it('keep training counts an unstamped source under the v2 rating', async () => {
    uploadRatings({ 'safe-1': 'PG', 'spicy-2': 'R' });
    getWorkflow.mockResolvedValueOnce({
      data: {
        id: 'wf-src-v2',
        metadata: {},
        steps: [
          {
            $type: 'training',
            input: {
              engine: 'ai-toolkit',
              ecosystem: 'sdxl',
              epochs: 10,
              steps: 2000,
              trainingData: { type: 'blobs', items: items('safe-1', 'spicy-2') },
            },
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-cont-v2' } });
    await continueTraining(
      client,
      { workflowId: 'wf-src-v2', fromEpoch: 10, addEpochs: 2 },
      {
        checkText,
        datasetRating: ratingAt(2, { 'spicy-2': { s: 1, r: false }, 'safe-1': { s: 0, r: false } }),
      }
    );
    expect('allowMatureContent' in lastBody()).toBe(false);
    expect(lastBody().metadata.matureCount).toBe(0);
  });

  // The rater's AIR names the blob by its full key, extension included: without it, it names no blob.
  it.each([
    ['an uploaded blob AIR', 'urn:air:other:blob:civitai:blob@abc.jpeg', 'abc.jpeg'],
    ['a generation blob URL', 'https://orch.example/v2/consumer/blobs/def.webp?sig=1', 'def.webp'],
    ['a bare blob key', 'ghi.png', 'ghi.png'],
  ])(
    '%s is HEADed and queued for rating by its key with the extension',
    async (_form, item, key) => {
      headBlob.mockReset();
      headBlob.mockResolvedValue({ response: new Response(null, { status: 204 }) });
      const count = await countDatasetMature(client, [item], ratingAt(1, {}));
      expect(headBlob.mock.calls[0]![0].path.blobId).toBe(key);
      expect(count.unratedKeys).toEqual([key]);
    }
  );

  it('a confirmed dataset v2 rates mature unlocks at submit', async () => {
    uploadRatings({ 'nude-1': 'PG' });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-acked-v2' } });
    await submitWith(ratingAt(1, { 'nude-1': { s: 4, r: false } }), {
      items: items('nude-1'),
      matureAck: true,
    });
    expect(lastBody().allowMatureContent).toBe(true);
  });

  it('a confirm sent for a dataset v2 rates below the level is not charged Yellow', async () => {
    uploadRatings({ 'outfit-1': 'X' });
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-acked-sfw' } });
    await submitWith(ratingAt(2, { 'outfit-1': { s: 1, r: false } }), {
      items: items('outfit-1'),
      currencies: ['blue', 'green'],
      matureAck: true,
    });
    expect('allowMatureContent' in lastBody()).toBe(false);
    expect(lastBody().currencies).toEqual(['blue', 'green']);
  });

  it('a confirm is kept when a HEAD fails, so the count cannot clear it', async () => {
    headBlob.mockImplementation(async () => ({ response: new Response(null, { status: 503 }) }));
    submitWorkflow.mockResolvedValueOnce({ data: { id: 'wf-acked-failed' } });
    await submitWith(ratingAt(2, {}), { items: items('x-1'), matureAck: true });
    expect(lastBody().allowMatureContent).toBe(true);
  });

  describe('keep training quotes', () => {
    const source = (id: string) => ({
      data: {
        id,
        metadata: {},
        steps: [
          {
            $type: 'training',
            input: {
              engine: 'ai-toolkit',
              ecosystem: 'sdxl',
              epochs: 10,
              steps: 2000,
              trainingData: { type: 'blobs', items: items('q-1') },
            },
            output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
          },
        ],
      },
    });
    const quote = async (workflowId: string, rating: DatasetRating | undefined) => {
      getWorkflow.mockResolvedValueOnce(source(workflowId));
      submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 900 } } });
      return (
        await continueTrainingWhatIf(
          client,
          { workflowId, fromEpoch: 10, addEpochs: 1 },
          { datasetRating: rating }
        )
      ).matureCount;
    };

    it('a count made at one setting, or without the rating, is not reused for another', async () => {
      uploadRatings({ 'q-1': 'R' });
      const stored = { 'q-1': { s: 2, r: false } };
      expect(await quote('wf-q-set', undefined)).toBe(1);
      expect(await quote('wf-q-set', ratingAt(4, stored))).toBe(0);
      expect(await quote('wf-q-set', ratingAt(1, stored))).toBe(1);
    });

    it('a count with unrated images is made again once they are rated', async () => {
      uploadRatings({ 'q-1': 'R' });
      const stored: Record<string, StoredRating> = {};
      const rating = ratingAt(4, stored);
      expect(await quote('wf-q-warm', rating)).toBe(1);
      stored['q-1'] = { s: 0, r: false };
      expect(await quote('wf-q-warm', rating)).toBe(0);
    });
  });

  // Each refusal, with a dataset the v2 rating calls not mature: the rating must not clear any of them.
  describe('every refusal still applies to a dataset rated not mature', () => {
    // Mature by its upload rating, not by v2: only the rating gets it past the mature check.
    const sfw = () => {
      uploadRatings({ 'sfw-1': 'R' });
      return ratingAt(1, { 'sfw-1': { s: 0, r: false } });
    };

    it('the trigger word check', async () => {
      const calls = submitWorkflow.mock.calls.length;
      const refuse: TrainingTextCheck = async () => {
        throw new TrainingTextRefusedError('blocked');
      };
      await expect(
        submitTrainingBatch(client, [{ ...baseRun(), items: items('sfw-1') }], {
          checkText: refuse,
          datasetRating: sfw(),
        })
      ).rejects.toBeInstanceOf(TrainingTextRefusedError);
      expect(submitWorkflow.mock.calls.length).toBe(calls);
    });

    it('training switched off', async () => {
      const calls = submitWorkflow.mock.calls.length;
      await expect(
        submitTrainingBatch(client, [{ ...baseRun(), items: items('sfw-1') }], {
          checkText,
          datasetRating: sfw(),
          status: parseServiceStatus({ available: false, message: 'Training is paused.' }),
        })
      ).rejects.toThrow(/Training is paused/);
      expect(submitWorkflow.mock.calls.length).toBe(calls);
    });

    it('a custom base that is not SafeTensor', async () => {
      const calls = submitWorkflow.mock.calls.length;
      getResource.mockResolvedValueOnce({ data: { fileFormat: 'PickleTensor' } });
      await expect(
        submitTrainingBatch(
          client,
          [
            {
              ...baseRun(),
              items: items('sfw-1'),
              customModel: 'urn:air:sdxl:checkpoint:civitai:1@2',
            },
          ],
          { checkText, datasetRating: sfw() }
        )
      ).rejects.toBeInstanceOf(TrainingBatchValidationError);
      expect(submitWorkflow.mock.calls.length).toBe(calls);
    });

    it('keep training checks the trigger word again', async () => {
      uploadRatings({ 'sfw-1': 'R' });
      getWorkflow.mockResolvedValueOnce({
        data: {
          id: 'wf-src-tw',
          metadata: {},
          steps: [
            {
              $type: 'training',
              input: {
                engine: 'ai-toolkit',
                ecosystem: 'sdxl',
                epochs: 10,
                steps: 2000,
                trainingData: { type: 'blobs', items: items('sfw-1') },
              },
              output: { epochs: [{ epochNumber: 10, model: { id: 'blob-10', available: true } }] },
            },
          ],
        },
      });
      const calls = submitWorkflow.mock.calls.length;
      await expect(
        continueTraining(
          client,
          { workflowId: 'wf-src-tw', fromEpoch: 10, addEpochs: 1 },
          {
            checkText: async () => {
              throw new TrainingTextRefusedError('blocked');
            },
            datasetRating: ratingAt(1, { 'sfw-1': { s: 0, r: false } }),
          }
        )
      ).rejects.toBeInstanceOf(TrainingTextRefusedError);
      expect(submitWorkflow.mock.calls.length).toBe(calls);
    });
  });
});

describe('a submit refused because a dataset file is still processing', () => {
  const notReadyText =
    "trainingData blob 'blob-1' is not available for training yet; try again shortly";
  const refusal = (extra: Record<string, unknown> = { code: 'trainingDataNotReady' }) => ({
    error: {
      title: 'One or more validation errors occurred.',
      status: 400,
      errors: { messages: [notReadyText] },
      ...extra,
    },
    response: { status: 400 },
  });

  it.each([
    ['its code', refusal()],
    ['its message when the code is absent', refusal({})],
    ['its message when the code is null', refusal({ code: null })],
  ])('is recognised by %s and shows only the neutral message', async (_, answer) => {
    submitWorkflow.mockResolvedValueOnce(answer);
    const err = await submitTrainingBatch(client, [baseRun()], { checkText }).catch((e) => e);
    expect(err).toBeInstanceOf(FilesProcessingError);
    expect(err.message).toBe(FILES_PROCESSING_MESSAGE);
  });

  it('leaves any other refusal on the existing path with its reason', async () => {
    submitWorkflow.mockResolvedValueOnce({
      error: { title: 'Bad', errors: { messages: ['steps must be positive'] } },
      response: { status: 400 },
    });
    const err = await submitTrainingBatch(client, [baseRun()], { checkText }).catch((e) => e);
    expect(err).not.toBeInstanceOf(FilesProcessingError);
    expect(err).toBeInstanceOf(TrainingSubmitError);
    expect(err.reason).toContain('steps must be positive');
  });

  it.each([
    ['a non-400 status', { ...refusal(), response: { status: 500 } }],
    [
      'an unrelated message beside it',
      {
        error: { errors: { messages: [notReadyText, 'steps must be positive'] } },
        response: { status: 400 },
      },
    ],
    [
      'another field error beside it',
      {
        error: { errors: { messages: [notReadyText], steps: ['must be at most 10000'] } },
        response: { status: 400 },
      },
    ],
  ])('is not matched with %s', async (_, answer) => {
    submitWorkflow.mockResolvedValueOnce(answer);
    const err = await submitTrainingBatch(client, [baseRun()], { checkText }).catch((e) => e);
    expect(err).not.toBeInstanceOf(FilesProcessingError);
    expect(err).toBeInstanceOf(TrainingSubmitError);
  });

  it('does not match the message under a different code', async () => {
    submitWorkflow.mockResolvedValueOnce(refusal({ code: 'somethingElse' }));
    const err = await submitTrainingBatch(client, [baseRun()], { checkText }).catch((e) => e);
    expect(err).not.toBeInstanceOf(FilesProcessingError);
  });

  it('after some runs landed, returns them instead of throwing, so a retry cannot resubmit them', async () => {
    submitWorkflow.mockReset();
    submitWorkflow
      .mockResolvedValueOnce({ data: { id: 'wf-landed' } })
      .mockResolvedValueOnce(refusal());
    const batch = await submitTrainingBatch(client, [baseRun(), { ...baseRun(), steps: 999 }], {
      checkText,
    });
    expect(batch).toEqual({ workflowIds: ['wf-landed'], failure: FILES_PROCESSING_PARTIAL_REASON });
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
  });
});

describe('trainingDataReady (the readiness whatif)', () => {
  const notReady = {
    error: { status: 400, code: 'trainingDataNotReady', errors: {} },
    response: { status: 400 },
  };

  it('is false only when the whatif says a dataset file is not ready', async () => {
    submitWorkflow.mockReset();
    submitWorkflow.mockResolvedValueOnce(notReady);
    expect(await trainingDataReady(client, baseRun())).toBe(false);
    const call = submitWorkflow.mock.calls[0]![0];
    expect(call.query).toEqual({ whatif: true });
    expect(call.body.steps[0].input.trainingData).toBeDefined();
  });

  it('is true when the whatif prices the run', async () => {
    submitWorkflow.mockResolvedValueOnce({ data: { cost: { total: 500 } } });
    expect(await trainingDataReady(client, baseRun())).toBe(true);
  });

  it('is null for any other refusal, so it never holds Start', async () => {
    submitWorkflow.mockResolvedValueOnce({
      error: { status: 400, code: 'somethingElse', errors: {} },
      response: { status: 400 },
    });
    expect(await trainingDataReady(client, baseRun())).toBeNull();
  });

  it('is null without asking for a run the submit would refuse anyway', async () => {
    submitWorkflow.mockReset();
    expect(await trainingDataReady(client, { ...baseRun(), items: [] })).toBeNull();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});
