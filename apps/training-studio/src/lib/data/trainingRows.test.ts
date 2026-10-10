import type { Workflow } from '@civitai/client';
import { describe, expect, it } from 'vitest';
import { epochArchiveEntries, workflowToDetail } from './trainingRows';

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

describe('epochArchiveEntries', () => {
  it('lists weights first then samples, ascending by epoch, skipping unavailable blobs', () => {
    const { entries, archiveName } = epochArchiveEntries(workflow());
    expect(archiveName).toBe('my-char-checkpoints.zip');
    expect(entries).toEqual([
      { blobId: 'M1.safetensors', fileName: 'my-char-epoch-01.safetensors' },
      { blobId: 'M2.safetensors', fileName: 'my-char-epoch-02.safetensors' },
      { blobId: 'S1a.png', fileName: 'my-char-epoch-01-sample-1.png' },
      { blobId: 'S2a.png', fileName: 'my-char-epoch-02-sample-1.png' },
    ]);
  });

  it('names a blob once even when two epochs point at it', () => {
    const w = workflow();
    const epochs = (w.steps![0] as unknown as { output: { epochs: { model: { id: string } }[] } })
      .output.epochs;
    epochs[1]!.model.id = epochs[0]!.model.id;
    const ids = epochArchiveEntries(w).entries.map((e) => e.blobId);
    expect(new Set(ids).size).toBe(ids.length);
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
    expect(epochArchiveEntries(legacy).entries).toEqual([]);
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
