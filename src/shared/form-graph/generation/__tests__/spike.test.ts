import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import { enumOf, slider, textOf } from 'form-graph/defs';

/**
 * Phase 0 spike: proves the published form-graph package works inside THIS
 * repo's toolchain before any porting starts — resolution of both entry
 * points, zod v4 interop (this repo is on zod ^4.0.17; form-graph declares it
 * as a peer), and that the vitest `unit` project runs it.
 *
 * It exercises the exact capabilities the generation port depends on:
 * conditional fields, the `_ext` bag, discriminated branching, server parse,
 * and store-level effects.
 */

const WORKFLOW = enumOf({
  options: [
    { value: 'txt2img', label: 'Text to image' },
    { value: 'img2img', label: 'Image to image' },
  ],
  default: 'txt2img',
});

const img2img = defineGraph<{ maxStrength: number }>()
  .field('sourceImage', textOf({ output: z.string().url('A source image is required') }))
  .field('strength', ({ _ext }) =>
    slider({ min: 0, max: _ext.maxStrength, step: 0.05, default: 0.75 })
  );

const txt2img = defineGraph<{ maxStrength: number }>()
  .field('steps', slider({ min: 1, max: 50, default: 25 }))
  // conditional: absent unless the user opted into hires
  .field(
    'hires',
    enumOf({
      options: [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
      ],
      default: 'off',
    })
  )
  .field('hiresScale', ({ hires }) =>
    hires === 'on' ? slider({ min: 1.5, max: 4, default: 2 }) : null
  );

const spikeGraph = defineGraph()
  .field('workflow', WORKFLOW)
  .use(
    branch('workflow', [
      [['txt2img'], txt2img],
      [['img2img'], img2img],
    ] as const)
  );

describe('form-graph package spike', () => {
  it('resolves both entry points and builds a store', () => {
    const store = spikeGraph.createStore({ ext: { maxStrength: 1 } });
    expect(store.getState()).toEqual({ workflow: 'txt2img', steps: 25, hires: 'off' });
  });

  it('conditional fields come and go by prior-field value', () => {
    const store = spikeGraph.createStore({ ext: { maxStrength: 1 } });
    expect(store.getField('hiresScale')).toBeNull();
    store.set({ hires: 'on' });
    expect(store.getField('hiresScale')?.value).toBe(2);
  });

  it('reads external context through the _ext bag', () => {
    const store = spikeGraph.createStore({ ext: { maxStrength: 0.6 } });
    store.set({ workflow: 'img2img' });
    expect(store.getField('strength')?.meta).toMatchObject({ max: 0.6 });
  });

  it('parses raw input server-side with zod v4 schemas', () => {
    const ok = spikeGraph.parse(
      { workflow: 'img2img', sourceImage: 'https://example.com/a.png', strength: 0.5 },
      { maxStrength: 1 }
    );
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toMatchObject({ workflow: 'img2img', strength: 0.5 });

    const bad = spikeGraph.parse(
      { workflow: 'img2img', sourceImage: 'not-a-url' },
      { maxStrength: 1 }
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(Object.keys(bad.errors)).toContain('sourceImage');
  });

  it('discriminates the state union on the branch key', () => {
    type State = ReturnType<typeof spikeGraph.resolve>;
    type Img2Img = Extract<State, { workflow: 'img2img' }>;
    type Assert<T extends true> = T;
    type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
      ? true
      : false;
    type _strengthIsNumber = Assert<Equals<Img2Img['strength'], number>>;
    type _noStepsOnImg2Img = Assert<Equals<'steps' extends keyof Img2Img ? true : false, false>>;
    expect(true).toBe(true);
  });

  it('runs effects on set(), rewriting the patch before intent', () => {
    const withRule = defineGraph()
      .field('steps', slider({ min: 1, max: 50, default: 25 }))
      .field(
        'quality',
        enumOf({
          options: [
            { value: 'draft', label: 'Draft' },
            { value: 'final', label: 'Final' },
          ],
          default: 'draft',
        })
      )
      // picking `final` implies a step floor — a coupling between two user choices
      .effect({
        quality: (quality, { next }) =>
          quality === 'final' && (next.steps ?? 0) < 20 ? { steps: 20 } : undefined,
      });

    const store = withRule.createStore();
    store.set({ steps: 5 });
    expect(store.getState()).toEqual({ steps: 5, quality: 'draft' });
    store.set({ quality: 'final' });
    expect(store.getState()).toEqual({ steps: 20, quality: 'final' });
  });
});
