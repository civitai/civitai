import { describe, expect, it, vi } from 'vitest';
import { cardByType } from '$lib/data/trainingModels';
import {
  continueTraining,
  continueTrainingWhatIf,
  MatureAckRequiredError,
  submitTraining,
  submitTrainingBatch,
  TrainingTextRefusedError,
  type TrainingRunInput,
  type TrainingTextCheck,
} from './train-core';

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
