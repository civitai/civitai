import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FsModule from 'fs';
import type * as FsPromises from 'fs/promises';

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof FsModule>();
  return {
    ...real,
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    createWriteStream: vi.fn(),
    writeSync: vi.fn(),
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return { ...real, writeFile: vi.fn(), appendFile: vi.fn() };
});

const fsp = await import('fs/promises');
const { solidPng } = await import('../decision-eval/controls');
const { choiceMapper, doneItemIds, HttpImageSource, runItems, runKey, specHash } = await import(
  '../decision-eval/runner'
);
const { EvalSafetyError } = await import('../decision-eval/safety');

import type {
  DecisionQuestion,
  ImageDecisionModel,
  ManifestItem,
  Prediction,
  TextDecisionModel,
} from '../decision-eval/types';

const question: DecisionQuestion = {
  id: 'verdict',
  type: 'choice',
  instructions: 'Does the image break the rule?',
  options: [
    { key: 'allow', description: 'it does not' },
    { key: 'block', description: 'it does' },
    { key: 'cannot_tell', description: 'the image does not show enough to tell' },
  ],
};
const format = { mapAnswer: choiceMapper('verdict', { abstainOptions: ['cannot_tell'] }) };

function answer(value: string, confidence = 0.9) {
  return {
    answers: [
      {
        id: 'verdict',
        type: 'choice' as const,
        value,
        probabilities: null,
        confidence,
        unknown: 0.01,
        abstained: false,
      },
    ],
    build: 'imajev-4b',
    latencyMs: 12,
  };
}

function imageModel(
  value = 'block'
): ImageDecisionModel & { decideWithImages: ReturnType<typeof vi.fn> } {
  return {
    configId: 'imajev:test',
    hosting: 'self-hosted',
    zeroDataRetention: true,
    decide: vi.fn().mockResolvedValue(answer(value)),
    decideWithImages: vi.fn().mockResolvedValue(answer(value)),
  };
}

const item = (itemId: string, extra: Partial<ManifestItem> = {}): ManifestItem => ({
  itemId,
  groupKey: itemId,
  ts: '2026-10-01T00:00:00Z',
  split: 'dev',
  state: { context: 'a removed image' },
  imageRefs: [{ url: `https://images.internal/${itemId}` }],
  ...extra,
});

const MARKER = solidPng(8, 8, [7, 77, 177]);

function imageSource(missing: string[] = []) {
  return {
    fetch: vi.fn(async (ref: { url: string }) =>
      missing.some((m) => ref.url.endsWith(m)) ? ('missing' as const) : MARKER
    ),
  };
}

async function run(
  opts: Partial<Parameters<typeof runItems>[0]> & Pick<Parameters<typeof runItems>[0], 'items'>
) {
  const predictions: Prediction[] = [];
  const summary = await runItems({
    questions: [question],
    format,
    model: imageModel(),
    dataClass: 'moderation-image',
    runKey: 'k',
    imageSource: imageSource(),
    done: new Set(),
    onPrediction: (p) => {
      predictions.push(p);
    },
    ...opts,
  });
  return { summary, predictions };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runItems', () => {
  it('🔴 records a deleted image as missing, never calls the model, and never scores it as an error', async () => {
    const model = imageModel();
    const { summary, predictions } = await run({
      items: [item('gone'), item('here')],
      model,
      imageSource: imageSource(['gone']),
    });
    expect(summary).toEqual({ ran: 1, skipped: 0, missing: 1, errors: 0 });
    expect(predictions[0]).toEqual({ itemId: 'gone', runKey: 'k', status: 'missing' });
    expect(model.decideWithImages).toHaveBeenCalledTimes(1);
  });

  it('🔴 skips items already predicted under the run key, so a daily run only sends new items', async () => {
    const model = imageModel();
    const { summary } = await run({ items: [item('a'), item('b')], model, done: new Set(['a']) });
    expect(summary).toMatchObject({ ran: 1, skipped: 1 });
    expect(model.decideWithImages).toHaveBeenCalledTimes(1);
  });

  it('retries failed calls on the next run but not missing or answered items', () => {
    const preds: Prediction[] = [
      { itemId: 'a', runKey: 'k', status: 'ok' },
      { itemId: 'b', runKey: 'k', status: 'missing' },
      { itemId: 'c', runKey: 'k', status: 'error', error: 'x' },
      { itemId: 'd', runKey: 'other', status: 'ok' },
      { itemId: 'e', runKey: 'k', status: 'error', error: 'x' },
      { itemId: 'e', runKey: 'k', status: 'ok' },
    ];
    expect([...doneItemIds(preds, 'k')].sort()).toEqual(['a', 'b', 'e']);
  });

  it('records a failed model call per item and carries on', async () => {
    const model = imageModel();
    model.decideWithImages.mockRejectedValueOnce(new Error('imajev returned HTTP 500'));
    const { summary, predictions } = await run({ items: [item('a'), item('b')], model });
    expect(summary).toMatchObject({ ran: 1, errors: 1 });
    expect(predictions[0]).toMatchObject({
      status: 'error',
      error: 'Error: imajev returned HTTP 500',
    });
  });

  it('🔴 aborts the whole run on PII in state, before any call', async () => {
    const model = imageModel();
    await expect(
      run({ items: [item('a', { state: { context: 'from jane@example.com' } })], model })
    ).rejects.toThrow(EvalSafetyError);
    expect(model.decideWithImages).not.toHaveBeenCalled();
  });

  it('🔴 refuses to send moderation images to a third-party arm', async () => {
    const hosted: TextDecisionModel = {
      configId: 'jev',
      hosting: 'third-party',
      zeroDataRetention: true,
      decide: vi.fn(),
    };
    await expect(run({ items: [item('a')], model: hosted })).rejects.toThrow(
      'moderation-image data may only go to a self-hosted arm'
    );
    expect(hosted.decide).not.toHaveBeenCalled();
  });

  it('refuses an image item for a text-only arm even when the data class would allow it', async () => {
    const hosted: TextDecisionModel = {
      configId: 'jev',
      hosting: 'third-party',
      zeroDataRetention: true,
      decide: vi.fn(),
    };
    await expect(
      run({ items: [item('a')], model: hosted, dataClass: 'support-text' })
    ).rejects.toThrow('cannot take them');
  });

  it('maps a "cannot tell" content option to an abstention', async () => {
    const { predictions } = await run({ items: [item('a')], model: imageModel('cannot_tell') });
    expect(predictions[0]).toMatchObject({ status: 'ok', pred: null, abstained: true });
  });

  it('🔴 writes nothing to disk while handling images', async () => {
    const source = new HttpImageSource(
      vi.fn(
        async () =>
          new Response(MARKER.bytes, { status: 200, headers: { 'content-type': 'image/png' } })
      )
    );
    const { predictions } = await run({ items: [item('a'), item('b')], imageSource: source });
    expect(predictions.map((p) => p.status)).toEqual(['ok', 'ok']);
    for (const spy of [
      fs.writeFileSync,
      fs.appendFileSync,
      fs.createWriteStream,
      fs.writeSync,
      fsp.writeFile,
      fsp.appendFile,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(predictions)).not.toContain(Buffer.from(MARKER.bytes).toString('base64'));

    // Positive control: the spies do see a write made through the same modules.
    fs.writeFileSync('x', 'y');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('HttpImageSource', () => {
  it('treats 404 and 410 as missing', async () => {
    for (const status of [404, 410]) {
      const source = new HttpImageSource(vi.fn(async () => new Response(null, { status })));
      await expect(source.fetch({ url: 'https://images.internal/1' })).resolves.toBe('missing');
    }
  });

  it('refuses bytes that do not match the manifest hash', async () => {
    const source = new HttpImageSource(
      vi.fn(async () => new Response(MARKER.bytes, { status: 200 }))
    );
    await expect(source.fetch({ url: 'u', sha256: 'f'.repeat(64) })).rejects.toThrow(
      'do not match the manifest sha256'
    );
    await expect(source.fetch({ url: 'u', sha256: MARKER.sha256 })).resolves.toMatchObject({
      sha256: MARKER.sha256,
    });
  });
});

describe('run identity', () => {
  it('changes the spec hash when a question changes, and the run key when the model config does', () => {
    const a = specHash('n', 1, 'A', [question]);
    expect(specHash('n', 1, 'A', [{ ...question, instructions: 'reworded' }])).not.toBe(a);
    expect(specHash('n', 2, 'A', [question])).not.toBe(a);
    expect(runKey('imajev:x', a)).not.toBe(runKey('imajev:y', a));
  });
});
