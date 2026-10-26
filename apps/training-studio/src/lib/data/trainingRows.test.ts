import type { Workflow } from '@civitai/client';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_TOKEN_BUDGET,
  MAX_ARCHIVE_ENTRIES,
  UNKNOWN_BASE,
  epochArchiveParts,
  estimateArchiveTokenLength,
  namedDownloadUrl,
  runFileStem,
  workflowToDetail,
} from './trainingRows';

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
  it('carries the run-describing input fields and nothing else', () => {
    const detail = workflowToDetail(workflow());
    expect(detail?.settings).toEqual({
      workflowId: 'wf-1',
      name: 'My Char!',
      createdAt: '2026-09-01T00:00:00.000Z',
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
      },
    });
    const text = JSON.stringify(detail?.settings);
    expect(text).not.toContain('sig=1');
    expect(text).not.toContain('defaultSteps');
    expect(text).not.toContain('trace');
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
