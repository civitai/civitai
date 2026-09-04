import { describe, expect, it } from 'vitest';
import { assertDifferential, runOracle, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * Differential parity for the STANDALONE workflows — the seven arms v1's
 * root discriminator serves outside the ecosystem graph (enhancements plus
 * the two empty no-submit panels). No ecosystem, so the matrix is
 * workflow x input shape x context.
 */

const BASE: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const CONTEXTS: [string, GenerationCtx][] = [
  ['base', BASE],
  [
    'freeTier',
    {
      ...BASE,
      user: { isMember: false, tier: 'free' },
      limits: { maxQuantity: 1, maxResources: 1, vidQuantity: 1 },
    },
  ],
];

const IMG = (w: number, h: number) => ({ url: 'https://example.com/a.png', width: w, height: h });
const VID = (w: number, h: number, fps: number) => ({
  url: 'https://example.com/a.mp4',
  metadata: { width: w, height: h, fps, duration: 5 },
});

const CASES: Array<{ workflow: string; shapes: AnyRecord[] }> = [
  {
    workflow: 'img2img:upscale',
    shapes: [
      {},
      { images: [IMG(512, 512)] },
      { images: [IMG(512, 512), IMG(1024, 768)] },
      // multiplier selection, incl. one useless-for-batch (resets to default)
      { images: [IMG(512, 512)], upscaleSelection: { type: 'multiplier', multiplier: 2 } },
      { images: [IMG(3000, 3000)], upscaleSelection: { type: 'multiplier', multiplier: 3 } },
      { images: [IMG(512, 512)], upscaleSelection: { type: 'resolution', resolution: 2048 } },
      // resolution useless (image already above target)
      { images: [IMG(3900, 3900)], upscaleSelection: { type: 'resolution', resolution: 2048 } },
      { images: [IMG(512, 512)], upscaler: { id: 147759, model: { type: 'Upscaler' } } },
      // over the batch cap
      { images: Array.from({ length: 12 }, () => IMG(256, 256)) },
    ],
  },
  {
    workflow: 'img2img:remove-background',
    shapes: [{}, { images: [IMG(512, 512)] }, { images: [IMG(512, 512), IMG(256, 256)] }],
  },
  {
    workflow: 'img2img:preprocess',
    shapes: [
      {},
      { images: [IMG(512, 512)] },
      { images: [IMG(512, 512)], preprocessKind: 'openpose' },
      {
        images: [IMG(512, 512)],
        preprocessKind: 'canny',
        preprocessResolution: 1024,
        kindParams: { lowThreshold: 50, highThreshold: 150 },
      },
      { images: [IMG(512, 512)], preprocessKind: 'not-a-kind' },
    ],
  },
  {
    workflow: 'vid2vid:upscale',
    shapes: [
      {},
      { video: VID(640, 480, 24) },
      { video: VID(640, 480, 24), scaleFactor: 3 },
      // x3 would exceed the 2560px ceiling
      { video: VID(1280, 720, 30), scaleFactor: 3 },
      { video: 'https://example.com/plain-url.mp4' },
    ],
  },
  {
    workflow: 'vid2vid:interpolate',
    shapes: [
      {},
      { video: VID(640, 480, 24) },
      { video: VID(640, 480, 24), interpolationFactor: 4 },
      // 4x60 exceeds the 120fps ceiling
      { video: VID(640, 480, 60), interpolationFactor: 4 },
    ],
  },
  { workflow: 'img2meta', shapes: [{}, { images: [IMG(512, 512)] }] },
  { workflow: 'prompt:enhance', shapes: [{}, { prompt: 'a cat' }] },
];

const port = {
  parse: (raw: AnyRecord, ext: never) => generationHub.parse(reconcileSelectors(raw).raw, ext),
};

type Combo = { name: string; input: AnyRecord; ext: GenerationCtx };

const COMBOS: Combo[] = [];
for (const [ctxName, ctx] of CONTEXTS) {
  for (const { workflow, shapes } of CASES) {
    for (const [i, shape] of shapes.entries()) {
      COMBOS.push({
        name: `${ctxName} | ${workflow} | shape${i}`,
        input: { workflow, ...shape },
        ext: ctx,
      });
    }
  }
}

describe('standalone workflows: differential parity with generationGraph', () => {
  it('covers every standalone workflow', () => {
    expect(COMBOS.length).toBeGreaterThan(50);
    const covered = new Set(COMBOS.map((c) => c.input.workflow));
    expect(CASES.map((c) => c.workflow).filter((w) => !covered.has(w))).toEqual([]);
  });

  it.each(COMBOS)('$name', ({ input, ext }) => {
    assertDifferential(port, { name: JSON.stringify(input), input }, ext);
  });

  it('sanity: the oracle serves the standalone arms (guards the whole matrix)', () => {
    const upscale = runOracle({ workflow: 'img2img:upscale', images: [IMG(512, 512)] }, BASE);
    expect(upscale.success).toBe(true);
  });
});
