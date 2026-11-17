import type { Workflow } from '@civitai/orchestration-client';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_TOKEN_BUDGET,
  MAX_ARCHIVE_ENTRIES,
  UNKNOWN_BASE,
  canDeleteRun,
  epochArchiveParts,
  estimateArchiveTokenLength,
  namedDownloadUrl,
  runFileStem,
  workflowToDetail,
  workflowToRow,
} from './trainingRows';
import { sampleReviewWorkflows } from './sampleReviewRuns';
import { canRaiseTrainingReview } from '@civitai/shared/training-review';

const workflow = (over: Record<string, unknown> = {}): Workflow =>
  ({
    id: 'wf-1',
    status: 'succeeded',
    createdAt: '2026-09-01T00:00:00.000Z',
    tags: ['civitai', 'training'],
    metadata: { name: 'My Char!', media: 'image', loraType: 'character', cardType: 'sdxl' },
    steps: [
      {
        $type: 'training',
        input: {
          engine: 'ai-toolkit',
          ecosystem: 'sdxl',
          steps: 2000,
          epochs: 3,
          lr: 5e-4,
          optimizerType: 'adafactor',
          shuffleTokens: true,
          keepTokens: 1,
          minSnrGamma: 5,
          triggerWord: 'ohwx',
          trace: 'events',
          defaultSteps: 2000,
          storageBuzzPerEpoch: 5,
          usesStepPricing: true,
          trainingData: {
            type: 'blobs',
            items: [{ air: 'https://x/blobs/A.png?sig=1', caption: 'ohwx, 1girl' }],
          },
          samples: { prompts: ['ohwx, a photo'] },
        },
        output: {
          epochs: [
            {
              epochNumber: 2,
              model: { id: 'M2.safetensors', url: 'https://x/m2', available: true },
              samples: [{ id: 'S2a.png', url: 'https://x/s2a', available: true }],
            },
            {
              epochNumber: 1,
              model: { id: 'M1.safetensors', url: 'https://x/m1', available: true },
              samples: [
                { id: 'S1a.png', url: 'https://x/s1a', available: true },
                { id: 'S1b.png', url: null, available: false },
              ],
            },
            { epochNumber: 3, model: { id: 'M3', available: false }, samples: [] },
          ],
        },
      },
    ],
    ...over,
  } as unknown as Workflow);

// A run shaped like one whose single weights+samples archive URL was refused with 414: 10 epochs x
// 6 samples, 26-char blob ids, a 22-char run slug.
const id26 = (e: number, s: number) => `E${e}S${s}`.padEnd(26, 'X');
const bigRun = (epochCount: number, samplesPerEpoch: number) =>
  workflow({
    metadata: { name: 'Abcdefghijklmnopq Moss', media: 'image', cardType: 'sdxl' },
    steps: [
      {
        $type: 'training',
        input: { engine: 'ai-toolkit', ecosystem: 'sdxl', epochs: epochCount },
        output: {
          epochs: Array.from({ length: epochCount }, (_, e) => ({
            epochNumber: e + 1,
            model: { id: `${id26(e, 99)}.safetensors`, url: 'https://x/m', available: true },
            samples: Array.from({ length: samplesPerEpoch }, (_, s) => ({
              id: `${id26(e, s)}.jpeg`,
              url: 'https://x/s',
              available: true,
            })),
          })),
        },
      },
    ],
  });

describe('epochArchiveParts', () => {
  it('puts weights and samples in separate archives, ascending by epoch, skipping unavailable blobs', () => {
    const stem = runFileStem('My Char!', workflowToDetail(workflow())!.base);
    expect(stem).not.toBe('my-char');
    expect(epochArchiveParts(workflow(), 'weights')).toEqual([
      {
        archiveName: `${stem}-checkpoints.zip`,
        entries: [
          { blobId: 'M1.safetensors', fileName: `${stem}-epoch-01.safetensors` },
          { blobId: 'M2.safetensors', fileName: `${stem}-epoch-02.safetensors` },
        ],
      },
    ]);
    expect(epochArchiveParts(workflow(), 'samples')).toEqual([
      {
        archiveName: `${stem}-samples.zip`,
        entries: [
          { blobId: 'S1a.png', fileName: `${stem}-epoch-01-sample-1.png` },
          { blobId: 'S2a.png', fileName: `${stem}-epoch-02-sample-1.png` },
        ],
      },
    ]);
  });

  it('names a blob once even when two epochs point at it', () => {
    const w = workflow();
    const epochs = (w.steps![0] as unknown as { output: { epochs: { model: { id: string } }[] } })
      .output.epochs;
    epochs[1]!.model.id = epochs[0]!.model.id;
    const ids = epochArchiveParts(w, 'weights').flatMap((p) => p.entries.map((e) => e.blobId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('estimates at least the measured token length of the archive refused with 414', () => {
    // The pre-split manifest of that run: weights then samples in one archive. 8917 is the length
    // of the token the orchestrator issued for it.
    const slug = 'abcdefghijklmnopq-moss';
    const pad = (n: number) => String(n).padStart(2, '0');
    const entries = [
      ...Array.from({ length: 10 }, (_, e) => ({
        blobId: `${id26(e, 99)}.safetensors`,
        fileName: `${slug}-epoch-${pad(e + 1)}.safetensors`,
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        blobId: `${id26(Math.floor(i / 6), i % 6)}.jpeg`,
        fileName: `${slug}-epoch-${pad(Math.floor(i / 6) + 1)}-sample-${(i % 6) + 1}.jpeg`,
      })),
    ];
    const estimate = estimateArchiveTokenLength({
      entries,
      archiveName: `${slug}-checkpoints.zip`,
    });
    expect(estimate).toBeGreaterThanOrEqual(8917);
    expect(estimate).toBeGreaterThan(ARCHIVE_TOKEN_BUDGET);
  });

  it.each([
    ['the reported run (10 epochs x 6 samples)', 10, 6],
    ['a 1000-sample run', 100, 10],
  ])(
    'keeps every archive of %s under the URL budget without dropping an entry',
    (_, epochs, samples) => {
      const w = bigRun(epochs, samples);
      for (const [kind, expected] of [
        ['weights', epochs],
        ['samples', epochs * samples],
      ] as const) {
        const parts = epochArchiveParts(w, kind);
        for (const part of parts) {
          expect(estimateArchiveTokenLength(part)).toBeLessThanOrEqual(ARCHIVE_TOKEN_BUDGET);
          expect(part.entries.length).toBeLessThanOrEqual(MAX_ARCHIVE_ENTRIES);
        }
        const all = parts.flatMap((p) => p.entries.map((e) => e.blobId));
        expect(all).toHaveLength(expected);
        expect(new Set(all).size).toBe(expected);
      }
    }
  );

  it('keeps the reported run weights in one archive and numbers split sample parts', () => {
    const w = bigRun(10, 6);
    expect(epochArchiveParts(w, 'weights')).toHaveLength(1);
    const parts = epochArchiveParts(w, 'samples');
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) =>
      expect(p.archiveName.endsWith(`-samples-${i + 1}-of-${parts.length}.zip`)).toBe(true)
    );
  });

  it('has nothing for a legacy run whose epochs carry only signed URLs', () => {
    const legacy = workflow({
      steps: [
        {
          $type: 'imageResourceTraining',
          input: {},
          output: { epochs: [{ epochNumber: 1, blobUrl: 'https://x/m1', sampleImages: [] }] },
        },
      ],
    });
    expect(epochArchiveParts(legacy, 'weights')).toEqual([]);
    expect(epochArchiveParts(legacy, 'samples')).toEqual([]);
  });
});

describe('runFileStem', () => {
  it('names the run and its base model', () => {
    expect(runFileStem('My Char!', 'Flux · Dev')).toBe('my-char-flux-dev');
  });
  it('drops the base when the run name already carries it, or the base is unknown', () => {
    expect(runFileStem('Ink Style Flux Dev', 'Flux · Dev')).toBe('ink-style-flux-dev');
    expect(runFileStem('My Char', UNKNOWN_BASE)).toBe('my-char');
  });
});

describe('namedDownloadUrl', () => {
  it('asks the orchestrator to serve the signed blob as an attachment with the given name', () => {
    const u = new URL(
      namedDownloadUrl(
        'https://orch.example/v2/consumer/blobs/K1.safetensors?sig=abc%2B&exp=2026-11-01T00:00:00Z',
        'my-char-flux-dev-epoch-03.safetensors'
      )
    );
    expect(u.toString()).toMatch(
      /^https:\/\/orch\.example\/v2\/consumer\/blobs\/K1\.safetensors\?sig=abc%2B&exp=2026-11-01T00:00:00Z&/
    );
    expect(u.searchParams.get('sig')).toBe('abc+');
    expect(u.searchParams.get('exp')).toBe('2026-11-01T00:00:00Z');
    expect(u.searchParams.get('filename')).toBe('my-char-flux-dev-epoch-03.safetensors');
    expect(u.searchParams.get('download')).toBe('true');
  });
  it('leaves a non-URL placeholder alone', () => {
    expect(namedDownloadUrl('#', 'x.safetensors')).toBe('#');
  });
});

describe('workflowToDetail settings export', () => {
  it('carries every training input field except the dataset, trace and pricing readouts', () => {
    const detail = workflowToDetail(workflow());
    expect(detail?.settings).toEqual({
      workflowId: 'wf-1',
      name: 'My Char!',
      createdAt: '2026-09-01T00:00:00.000Z',
      base: 'SDXL',
      media: 'image',
      loraType: 'character',
      cardType: 'sdxl',
      imageCount: 1,
      samplePrompts: ['ohwx, a photo'],
      training: {
        engine: 'ai-toolkit',
        ecosystem: 'sdxl',
        steps: 2000,
        epochs: 3,
        lr: 5e-4,
        optimizerType: 'adafactor',
        shuffleTokens: true,
        keepTokens: 1,
        minSnrGamma: 5,
        triggerWord: 'ohwx',
        defaultSteps: 2000,
      },
    });
    const text = JSON.stringify(detail?.settings);
    expect(text).not.toContain('sig=1');
    expect(text).not.toContain('trace');
  });

  it("leaves a continuation's source checkpoint out", () => {
    const source = 'urn:air:sdxl:lora:orchestrator:blob@parent-weights-key';
    const base = workflow();
    const step = (base.steps as unknown as { input: Record<string, unknown> }[])[0]!;
    step.input = { ...step.input, continueFrom: source };
    const detail = workflowToDetail(base);
    expect(detail?.settings.training).toMatchObject({ ecosystem: 'sdxl' });
    expect(JSON.stringify(detail)).not.toContain('parent-weights-key');
  });

  it("keeps a legacy kohya run's engine-specific params", () => {
    const detail = workflowToDetail(
      workflow({
        metadata: {},
        steps: [
          {
            $type: 'imageResourceTraining',
            input: {
              engine: 'kohya',
              model: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
              loraName: 'ohwx',
              trainingData: 'https://x/data.zip?sig=1',
              trainingDataImagesCount: 12,
              unetLR: 5e-4,
              maxTrainEpochs: 10,
              numRepeats: 8,
              clipSkip: 2,
              enableBucket: true,
              optimizerArgs: 'weight_decay=0.1',
            },
            output: { epochs: [], sampleImagesPrompts: ['ohwx'] },
          },
        ],
      })
    )!;
    expect(detail.settings.training).toMatchObject({
      engine: 'kohya',
      unetLR: 5e-4,
      maxTrainEpochs: 10,
      numRepeats: 8,
      clipSkip: 2,
      enableBucket: true,
      optimizerArgs: 'weight_decay=0.1',
    });
    expect(detail.settings.imageCount).toBe(12);
    expect(JSON.stringify(detail.settings)).not.toContain('sig=1');
  });

  it("reads a legacy run's prompts off its input when the output carries none", () => {
    const detail = workflowToDetail(
      workflow({
        metadata: {},
        steps: [
          {
            $type: 'imageResourceTraining',
            input: { engine: 'kohya', samplePrompts: ['ohwx, a photo', 'ohwx, a sketch'] },
            output: { epochs: [] },
          },
        ],
      })
    )!;
    expect(detail.prompts).toEqual(['ohwx, a photo', 'ohwx, a sketch']);
    expect(detail.settings.samplePrompts).toEqual(['ohwx, a photo', 'ohwx, a sketch']);
    expect(detail.settings.training).not.toHaveProperty('samplePrompts');
  });

  it("skips an empty output prompt list for a legacy run's input prompts", () => {
    const detail = workflowToDetail(
      workflow({
        metadata: {},
        steps: [
          {
            $type: 'imageResourceTraining',
            input: { engine: 'kohya', samplePrompts: ['ohwx, a photo'] },
            output: { epochs: [], sampleImagesPrompts: [] },
          },
        ],
      })
    )!;
    expect(detail.prompts).toEqual(['ohwx, a photo']);
  });

  it('keeps the sample generation settings but not the sample media, and records lineage', () => {
    const w = workflow({
      metadata: { name: 'Again', sourceWorkflowId: 'wf-0', sourceEpoch: 4 },
    });
    const input = (w.steps![0] as unknown as { input: Record<string, unknown> }).input;
    input.samples = {
      prompts: ['ohwx'],
      sourceImages: ['https://x/in.png?sig=1'],
      cfgScale: 4,
      strength: 0.8,
    };
    const { settings } = workflowToDetail(w)!;
    expect(settings.training.samples).toEqual({ cfgScale: 4, strength: 0.8 });
    expect(settings).toMatchObject({ sourceWorkflowId: 'wf-0', sourceEpoch: 4 });
    expect(JSON.stringify(settings)).not.toContain('sig=1');
  });

  it('leaves out a field it does not know that carries a signed URL', () => {
    const w = workflow();
    const input = (w.steps![0] as unknown as { input: Record<string, unknown> }).input;
    input.referenceImages = ['https://x/blobs/R.png?sig=2'];
    input.loraName = 'see https://civitai.com';
    const { training } = workflowToDetail(w)!.settings;
    expect(training).not.toHaveProperty('referenceImages');
    expect(training.loraName).toBe('see https://civitai.com');
  });

  it('leaves out a sample setting it does not know that carries a signed URL', () => {
    const w = workflow();
    const input = (w.steps![0] as unknown as { input: Record<string, unknown> }).input;
    input.samples = { prompts: ['ohwx'], cfgScale: 4, referenceImage: 'https://x/r.png?sig=3' };
    const { training } = workflowToDetail(w)!.settings;
    expect(training.samples).toEqual({ cfgScale: 4 });
  });
});

describe('workflowToDetail sample input images', () => {
  it("reads an edit run's input images, index-aligned to its prompts", () => {
    const w = workflow();
    const input = (w.steps![0] as unknown as { input: Record<string, unknown> }).input;
    input.samples = { prompts: ['ohwx, make it night'], sourceImages: ['https://x/in-a.png'] };
    const detail = workflowToDetail(w)!;
    expect(detail.prompts).toEqual(['ohwx, make it night']);
    expect(detail.sourceImages).toEqual(['https://x/in-a.png']);
  });

  it('carries none for a text-only run', () => {
    expect(workflowToDetail(workflow())!.sourceImages).toBeUndefined();
  });
});

describe('workflowToDetail dataset', () => {
  const editWorkflow = () => {
    const w = workflow();
    const input = (w.steps![0] as unknown as { input: Record<string, unknown> }).input;
    input.isEditTraining = true;
    input.trainingData = {
      type: 'blobs',
      items: [
        { air: 'start-a', caption: '', path: 'control_1/pair_0001.png' },
        { air: 'res-a', caption: 'add a smiley', path: 'main/pair_0001.png' },
      ],
    };
    return w;
  };

  it("keeps an edit run's pair paths and counts its pairs", () => {
    const detail = workflowToDetail(editWorkflow())!;
    expect(detail.dataset).toEqual([
      { air: 'start-a', caption: '', path: 'control_1/pair_0001.png' },
      { air: 'res-a', caption: 'add a smiley', path: 'main/pair_0001.png' },
    ]);
    expect(detail.settings.imageCount).toBe(1);
  });

  it('offers no dataset for an edit run whose items lost their paths', () => {
    const w = editWorkflow();
    const input = (w.steps![0] as unknown as { input: Record<string, unknown> }).input;
    input.trainingData = { type: 'blobs', items: [{ air: 'start-a', caption: '' }] };
    expect(workflowToDetail(w)!.dataset).toEqual([]);
  });

  it('gives a plain run no paths', () => {
    expect(workflowToDetail(workflow())!.dataset).toEqual([
      { air: 'https://x/blobs/A.png?sig=1', caption: 'ohwx, 1girl' },
    ]);
  });
});

describe('a run held for review', () => {
  // The orchestrator keeps the workflow `processing` while the gate holds it; only the training
  // step's output says why it isn't moving.
  const held = (moderationStatus: string, status = 'processing') =>
    workflow({
      status,
      steps: [
        {
          $type: 'training',
          input: { engine: 'ai-toolkit', ecosystem: 'sdxl', epochs: 10 },
          output: { moderationStatus, epochs: [] },
        },
      ],
    });

  it('reads as pending review, not training, on the list and the detail', () => {
    expect(workflowToRow(held('underReview'))?.state).toBe('review');
    expect(workflowToDetail(held('underReview'))?.state).toBe('review');
  });

  it('reads the manager API spelling too', () => {
    expect(workflowToRow(held('UnderReview'))?.state).toBe('review');
  });

  it('keeps an approved run that is training as training', () => {
    expect(workflowToRow(held('approved'))?.state).toBe('training');
  });

  it('reads a rejected run as not approved, not as a crash', () => {
    expect(workflowToRow(held('rejected'))?.state).toBe('rejected');
    expect(workflowToDetail(held('rejected'))?.state).toBe('rejected');
    expect(workflowToRow(held('rejected', 'failed'))?.state).toBe('rejected');
    expect(workflowToRow(held('rejected', 'canceled'))?.state).toBe('rejected');
  });

  it('reads a run that expired at the gate as not reviewed in time, not as a crash', () => {
    expect(workflowToRow(held('rejected', 'expired'))?.state).toBe('unreviewed');
    expect(workflowToRow(held('underReview', 'expired'))?.state).toBe('unreviewed');
  });

  it('only reads as pending review while the workflow is still running', () => {
    expect(workflowToRow(held('underReview', 'failed'))?.state).toBe('failed');
    expect(workflowToRow(held('underReview', 'succeeded'))?.state).toBe('ready');
  });

  it('still drops a workflow with no status, held or not', () => {
    const w = held('underReview');
    delete (w as { status?: unknown }).status;
    expect(workflowToRow(w)).toBeNull();
  });

  it('keeps a published run published', () => {
    const w = held('underReview');
    (w as { metadata: Record<string, unknown> }).metadata = { name: 'x', published: true };
    expect(workflowToRow(w)?.state).toBe('published');
  });

  it('offers a support ticket only once the preview run has been held long enough', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    const byId = new Map(sampleReviewWorkflows(now).map((w) => [w.id, workflowToDetail(w)]));
    const raisable = (id: string) => canRaiseTrainingReview(byId.get(id)?.heldSince, new Date(now));
    expect(raisable('preview-held')).toBe(false);
    expect(raisable('preview-held-long')).toBe(true);
    expect(byId.get('preview-not-approved')?.heldSince).toBeUndefined();
  });

  it('leaves a run that failed after it was approved as failed', () => {
    expect(workflowToRow(held('approved', 'failed'))?.state).toBe('failed');
    expect(workflowToRow(held('approved', 'expired'))?.state).toBe('failed');
  });

  it('cannot be deleted while held, and can once it ended at the gate', () => {
    expect(canDeleteRun({ state: 'review', hasModel: false })).toBe(false);
    expect(canDeleteRun({ state: 'rejected', hasModel: false })).toBe(true);
    expect(canDeleteRun({ state: 'unreviewed', hasModel: false })).toBe(true);
  });
});

it('reads checkpoint count, ecosystem and effective settings from Kohya runs', () => {
  const detail = workflowToDetail(
    workflow({
      steps: [
        {
          $type: 'training',
          input: {
            engine: 'kohya',
            model: 'urn:air:sdxl:checkpoint:civitai:123@456',
            maxTrainEpochs: 5,
            steps: 1000,
            trainBatchSize: 2,
            unetLR: 0.0005,
            textEncoderLR: 0,
            numRepeats: 20,
            clipSkip: 1,
            lrSchedulerNumCycles: 3,
            vParameterization: true,
            samples: { prompts: ['ohwx, portrait'], negativePrompt: 'blurry' },
            trainingData: { type: 'blobs', items: [{ air: 'image-1', caption: 'ohwx, portrait' }] },
          },
          output: { epochs: [{ epochNumber: 1, model: { id: 'weights-1', available: true } }] },
        },
      ],
    })
  );
  expect(detail).toMatchObject({ ecosystem: 'sdxl', plannedEpochs: 5 });
  expect(detail!.settings.training).toMatchObject({
    engine: 'kohya',
    epochs: 5,
    batchSize: 2,
    lr: 0.0005,
    textEncoderLr: 0,
    numRepeats: 20,
    vParameterization: true,
  });
  expect(detail!.dataset).toEqual([{ air: 'image-1', caption: 'ohwx, portrait' }]);
  expect(detail!.settings.negativePrompt).toBe('blurry');
});
