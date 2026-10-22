import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTrainingConsentCopy,
  isTrainingSubmitTransportError,
  resolveRunTrainingRequest,
  resolveTrainingConsentThumbnails,
  trainingSubmitReplyFromError,
  trainingSubmitReplyFromResult,
  type TrainingQuotePreview,
} from '~/components/AppBlocks/runTrainingGate';

const OK = { ready: true, signedIn: true, reviewNack: false };
const BODY = { kind: 'training', quoteId: 'tq_1', items: [{ air: 'K1', caption: '' }] };

describe('resolveRunTrainingRequest', () => {
  it('drops only what has no requestId to answer', () => {
    expect(resolveRunTrainingRequest({ raw: null, ...OK })).toEqual({ kind: 'drop' });
    expect(resolveRunTrainingRequest({ raw: { body: BODY }, ...OK })).toEqual({ kind: 'drop' });
    expect(resolveRunTrainingRequest({ raw: { requestId: '', body: BODY }, ...OK })).toEqual({
      kind: 'drop',
    });
  });

  it.each([
    ['review mode', { ...OK, reviewNack: true }, BODY, 'review-mode'],
    ['a block that is not ready', { ...OK, ready: false }, BODY, 'block is not ready'],
    ['an anonymous viewer', { ...OK, signedIn: false }, BODY, 'sign in to train'],
    ['a non-training body', OK, { ...BODY, kind: 'step' }, 'invalid training request'],
    ['a body naming no quote', OK, { kind: 'training' }, 'invalid training request'],
    ['an array body', OK, [BODY], 'invalid training request'],
  ])('refuses %s with a reply', (_l, flags, body, error) => {
    expect(resolveRunTrainingRequest({ raw: { requestId: 'r1', body }, ...flags })).toEqual({
      kind: 'refuse',
      requestId: 'r1',
      error,
    });
  });

  it('proceeds with the body untouched and the quote id read off it', () => {
    expect(resolveRunTrainingRequest({ raw: { requestId: 'r1', body: BODY }, ...OK })).toEqual({
      kind: 'proceed',
      request: { requestId: 'r1', quoteId: 'tq_1', body: BODY },
    });
  });
});

describe('buildTrainingConsentCopy', () => {
  const PREVIEW: TrainingQuotePreview = {
    quoteId: 'tq_1',
    total: 1234,
    imageCount: 7,
    modelName: 'SDXL',
    epochs: 5,
    steps: 1500,
    expiresAt: 'x',
    itemKeys: ['K1'],
    shortfall: 0,
  };

  it('every number is the server preview’s', () => {
    const copy = buildTrainingConsentCopy({ appName: 'Trainer', preview: PREVIEW });
    expect(copy.priceLine).toBe('This run costs 1,234 Buzz, charged when it starts.');
    expect(copy.confirmLabel).toBe('Train for 1,234 Buzz');
    expect(copy.intro).toBe('Trainer wants to train a LoRA on 7 images you uploaded.');
    expect(copy.details).toEqual([
      'Base model: SDXL',
      'Length: 5 epochs, 1500 steps',
      'Dataset: 7 images',
    ]);
    expect(copy.shortfallLine).toBeNull();
  });

  it('names a shortfall only when the server reports one', () => {
    expect(
      buildTrainingConsentCopy({ preview: { ...PREVIEW, shortfall: 300 } }).shortfallLine
    ).toBe('You need 300 more Buzz to start this run.');
    expect(
      buildTrainingConsentCopy({ preview: { ...PREVIEW, shortfall: null } }).shortfallLine
    ).toBeNull();
  });

  it('sanitizes the publisher-controlled app name', () => {
    const copy = buildTrainingConsentCopy({ appName: 'Ev\u202Eil\u200B', preview: PREVIEW });
    expect(copy.intro.startsWith('Evil wants')).toBe(true);
    expect(buildTrainingConsentCopy({ appName: '\u200B', preview: PREVIEW }).intro).toMatch(
      /^This app wants/
    );
  });
});

describe('resolveTrainingConsentThumbnails', () => {
  const uploads = new Map([
    ['k1.jpeg', 'https://o.civitai.com/v2/consumer/blobs/K1.jpeg?s=1'],
    ['k2.jpeg', 'https://o.civitai.com/v2/consumer/blobs/K2.jpeg?s=2'],
  ]);

  it('shows this host’s own upload of each quoted key, in the quote’s order', () => {
    expect(resolveTrainingConsentThumbnails({ itemKeys: ['K2.jpeg', 'K1.jpeg'] }, uploads)).toEqual(
      [
        'https://o.civitai.com/v2/consumer/blobs/K2.jpeg?s=2',
        'https://o.civitai.com/v2/consumer/blobs/K1.jpeg?s=1',
      ]
    );
    expect(
      resolveTrainingConsentThumbnails({ itemKeys: ['K1.jpeg', 'K2.jpeg'] }, uploads, 1)
    ).toEqual(['https://o.civitai.com/v2/consumer/blobs/K1.jpeg?s=1']);
  });

  it('shows at most twelve by default', () => {
    const many = new Map(Array.from({ length: 13 }, (_, i) => [`k${i}`, `u${i}`] as const));
    const keys = Array.from({ length: 13 }, (_, i) => `K${i}`);
    expect(resolveTrainingConsentThumbnails({ itemKeys: keys }, many)).toEqual(
      Array.from({ length: 12 }, (_, i) => `u${i}`)
    );
  });

  it('is null when the quote names any key this host did not upload', () => {
    expect(
      resolveTrainingConsentThumbnails({ itemKeys: ['K1.jpeg', 'K3.jpeg'] }, uploads)
    ).toBeNull();
    expect(resolveTrainingConsentThumbnails({ itemKeys: ['K1.jpeg'] }, new Map())).toBeNull();
    expect(
      resolveTrainingConsentThumbnails({ itemKeys: undefined as unknown as string[] }, uploads)
    ).toBeNull();
  });
});

describe('isTrainingSubmitTransportError', () => {
  it('is true only when no tRPC error code came back', () => {
    expect(isTrainingSubmitTransportError(new Error('Failed to fetch'))).toBe(true);
    expect(isTrainingSubmitTransportError(undefined)).toBe(true);
    expect(
      isTrainingSubmitTransportError(Object.assign(new Error('x'), { data: { code: 'FORBIDDEN' } }))
    ).toBe(false);
    expect(
      isTrainingSubmitTransportError(Object.assign(new Error('x'), { data: { code: 'CONFLICT' } }))
    ).toBe(false);
  });
});

describe('training submit replies', () => {
  const coded = (code: string, message = code) =>
    Object.assign(new Error(message), { data: { code } });

  it('a returned run is passed on as its snapshot', () => {
    expect(trainingSubmitReplyFromResult({ snapshot: { workflowId: '42-1' } })).toEqual({
      snapshot: { workflowId: '42-1' },
    });
  });

  it('a server answer marked unconfirmed is `submission-unconfirmed`, never its failed snapshot', () => {
    expect(
      trainingSubmitReplyFromResult({
        snapshot: { workflowId: 'failed', status: 'failed' },
        submissionUnconfirmed: true,
      })
    ).toEqual({ error: 'submission-unconfirmed' });
  });

  it('only the literal `true` marks it unconfirmed', () => {
    expect(
      trainingSubmitReplyFromResult({ snapshot: { workflowId: 'w' }, submissionUnconfirmed: 'yes' })
    ).toEqual({ snapshot: { workflowId: 'w' } });
  });

  it('a transport failure is `submission-unconfirmed` (the server may have run it)', () => {
    expect(trainingSubmitReplyFromError(new Error('Failed to fetch'))).toEqual({
      error: 'submission-unconfirmed',
    });
  });

  it('a coded server refusal is passed on as its message', () => {
    expect(trainingSubmitReplyFromError(coded('FORBIDDEN', 'not confirmed'))).toEqual({
      error: 'not confirmed',
    });
  });
});

/**
 * THE CLIENT-BUNDLE RELATIONSHIP. `PageBlockHost` imports this gate statically, so
 * everything it imports at RUNTIME ships in the page host's chunk: an import of
 * `workflow.schema` here would put every step and recipe registry in front of every
 * app page's first render. The dataset schema
 * lives in `training-dataset.schema.ts` (zod only) so that `workflow.schema.ts` — and
 * the step/recipe registries it imports — stays out. Pinned as a set: it fails if the
 * closure GROWS or SHRINKS.
 */
describe('runTrainingGate runtime import closure', () => {
  const SRC = resolve(__dirname, '../../..');
  // Blind spots, acceptable for this module set: side-effect imports, dynamic
  // `import()`, double-quoted specifiers and relative specifiers (recorded, not followed).
  const IMPORT_RE = /^(import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm;

  function closure(entry: string): string[] {
    const seen = new Set<string>();
    const walk = (spec: string) => {
      if (seen.has(spec)) return;
      seen.add(spec);
      if (!spec.startsWith('~/')) return;
      const base = resolve(SRC, spec.slice(2));
      if (/\.json$/.test(base)) return;
      const file = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(existsSync);
      if (!file) throw new Error(`unresolved import ${spec}`);
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) walk(m[2]);
    };
    walk(entry);
    return [...seen].sort();
  }

  it('is exactly the gate, the app-name sanitizer, the slim schemas and zod', () => {
    expect(closure('~/components/AppBlocks/runTrainingGate')).toEqual([
      'zod',
      '~/components/AppBlocks/appChromeName',
      '~/components/AppBlocks/runTrainingGate',
      '~/server/schema/blocks/civitai-image-url',
      '~/server/schema/blocks/training-dataset.schema',
    ]);
  });

  it('the walker sees through to the registries when workflow.schema IS imported (positive control)', () => {
    expect(closure('~/server/schema/blocks/workflow.schema')).toContain(
      '~/server/services/blocks/steps'
    );
  });
});
