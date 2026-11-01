import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { solidPng } from '../decision-eval/controls';
import {
  choiceMapper,
  doneItemIds,
  HttpImageSource,
  MAX_ATTEMPTS,
  runItems,
  runKey,
  specHash,
} from '../decision-eval/runner';
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
    hostKind: 'loopback',
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
    expect(summary).toEqual({ ran: 1, skipped: 0, missing: 1, errors: 0, refused: 0 });
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

  it('🔴 refuses an item whose state carries PII without sending it, and carries on with the rest', async () => {
    const model = imageModel();
    const source = imageSource();
    const { summary, predictions } = await run({
      items: [item('a', { state: { context: 'from jane@example.com' } }), item('b')],
      model,
      imageSource: source,
    });
    expect(summary).toMatchObject({ ran: 1, refused: 1, errors: 0 });
    expect(predictions[0]).toEqual({
      itemId: 'a',
      runKey: 'k',
      status: 'refused',
      error: 'state.context contains a email-shaped string',
    });
    expect(model.decideWithImages).toHaveBeenCalledTimes(1);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    // A refused item stays refused: its manifest state cannot change without a rebuild.
    expect(doneItemIds(predictions, 'k').has('a')).toBe(true);
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

  it('🔴 keeps image bytes out of the predictions it writes', async () => {
    const source = new HttpImageSource(
      vi.fn(
        async () =>
          new Response(MARKER.bytes, { status: 200, headers: { 'content-type': 'image/png' } })
      )
    );
    const { predictions } = await run({ items: [item('a')], imageSource: source });
    expect(predictions).toEqual([
      {
        itemId: 'a',
        runKey: 'k',
        status: 'ok',
        pred: 'block',
        confidence: 0.9,
        abstained: false,
        answers: answer('block').answers,
        build: 'imajev-4b',
        latencyMs: 12,
      },
    ]);
  });

  it('gives up on an item after MAX_ATTEMPTS failures, so one bad item cannot cost a timeout every day', () => {
    const failures = (n: number): Prediction[] =>
      Array.from({ length: n }, () => ({
        itemId: 'x',
        runKey: 'k',
        status: 'error' as const,
        error: 'e',
      }));
    expect(doneItemIds(failures(MAX_ATTEMPTS - 1), 'k').has('x')).toBe(false);
    expect(doneItemIds(failures(MAX_ATTEMPTS), 'k').has('x')).toBe(true);
  });
});

describe('🔴 the image path cannot touch the filesystem', () => {
  const dir = join(__dirname, '..', 'decision-eval');
  const SPECIFIER =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  const FS_LIKE = /^(?:node:)?fs(?:\/|$)|^(?:fs-extra|graceful-fs|mz\/fs)$/;
  // Builtins the image path may use; anything else (an alias, a package) would be unread code.
  const ALLOWED_EXTERNAL = new Set(['crypto', 'net', 'path', 'fs']);

  function specifiers(source: string): string[] {
    // A load this reader cannot resolve to a literal is a load it cannot vouch for.
    if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source) || /getBuiltinModule/.test(source)) {
      throw new Error('a module is loaded by a non-literal specifier');
    }
    return [...source.matchAll(SPECIFIER)].map((m) => m[1]);
  }

  /** Every module the image path loads, following every relative import spelling from its entry points. */
  function imagePathModules(): Map<string, string> {
    const seen = new Map<string, string>();
    const queue = ['runner.ts', 'imajev-client.ts'];
    while (queue.length) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      seen.set(file, source);
      for (const spec of specifiers(source)) {
        if (spec.startsWith('.')) {
          const local = /^\.\/([\w-]+)(?:\.(?:js|ts))?$/.exec(spec);
          if (!local)
            throw new Error(`${file} imports ${spec}, outside this directory's flat layout`);
          queue.push(`${local[1]}.ts`);
        } else if (!ALLOWED_EXTERNAL.has(spec.replace(/^node:/, ''))) {
          throw new Error(`${file} imports ${spec}, which this guard does not read`);
        }
      }
    }
    return seen;
  }

  it('imports fs nowhere on the image path except one read-only line in the data-dir check', () => {
    const modules = imagePathModules();
    expect([...modules.keys()].sort()).toEqual([
      'imajev-client.ts',
      'runner.ts',
      'safety.ts',
      'types.ts',
    ]);
    const fsImports = [...modules].flatMap(([file, src]) =>
      specifiers(src)
        .filter((s) => FS_LIKE.test(s))
        .map(() => file)
    );
    expect(fsImports).toEqual(['safety.ts']);
    expect(modules.get('safety.ts')).toMatch(/^import \{ existsSync, realpathSync \} from 'fs';$/m);
  });

  it('positive control: the reader sees every import spelling, and the fs test every fs spelling', () => {
    expect(
      specifiers(
        [
          "import { a } from './a';",
          "export * from './b.js';",
          "const c = await import('./c');",
          "const d = require('./d.ts');",
          "import './e';",
          "import x from '~/server/f';",
        ].join('\n')
      )
    ).toEqual(['./a', './b.js', './c', './d.ts', './e', '~/server/f']);
    for (const spec of [
      'fs',
      'node:fs',
      'fs/promises',
      'node:fs/promises',
      'fs-extra',
      'graceful-fs',
    ]) {
      expect(FS_LIKE.test(spec)).toBe(true);
    }
    expect(FS_LIKE.test('fsevents-but-not-fs')).toBe(false);
    for (const src of [
      'const s = await import(`./store`);',
      'const s = require(name);',
      "const fs = process.getBuiltinModule('fs');",
    ]) {
      expect(() => specifiers(src)).toThrow('non-literal specifier');
    }
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
