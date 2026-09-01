import { describe, expect, it } from 'vitest';
import { assertDifferential, runOracle, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
import { ecosystemToVersionDef } from '../video/wan.graph';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * Differential parity for the ported video slice (LTX + Wan + the hub) against
 * the live `generationGraph.safeParse`.
 *
 * The matrix is GENERATED rather than hand-listed: every Wan and LTX ecosystem
 * crossed with every workflow the ecosystem actually supports, crossed with a
 * set of input shapes and four external contexts. Generating it means a new
 * ecosystem or workflow is covered the day it is added, instead of the day
 * someone remembers to add a case.
 *
 * Combinations the ecosystem does NOT support are skipped deliberately: the
 * oracle's effects redirect those out of the video families entirely (a
 * `vid2vid:extend` on a Wan ecosystem lands on SD1), so they test the image
 * graphs, not this port.
 */

const BASE: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const CONTEXTS: [string, GenerationCtx][] = [
  ['base', BASE],
  ['wildcards', { ...BASE, flags: { wildcards: true } as GenerationCtx['flags'] }],
  ['wan22MultiStep', { ...BASE, flags: { wan22MultiStep: true } as GenerationCtx['flags'] }],
  [
    'freeTier',
    {
      ...BASE,
      user: { isMember: false, tier: 'free' },
      limits: { maxQuantity: 1, maxResources: 1, vidQuantity: 1 },
    },
  ],
  [
    'gated',
    {
      ...BASE,
      gateRules: [
        {
          // hidden selection drops at the boundary and falls back to the
          // default ecosystem (Seedance)
          id: 'test-hide-ltxv2',
          name: 'hide LTXV2',
          availableTo: 'nobody',
          presentation: 'hidden',
          ecosystems: ['LTXV2'],
          workflows: [],
          modelVersionIds: [],
        },
        {
          id: 'test-disable-ref2vid',
          name: 'disable ref2vid',
          availableTo: 'nobody',
          presentation: 'disabled',
          ecosystems: [],
          workflows: ['img2vid:ref2vid'],
          modelVersionIds: [],
        },
      ] as GenerationCtx['gateRules'],
    },
  ],
];

const IMAGE = { url: 'https://example.com/a.png', width: 1280, height: 720 };
const VIDEO_INPUT = { url: 'https://example.com/a.mp4' };

/** Input shapes: defaults, media, explicit values, empty prompt, over-cap values. */
const INPUT_SHAPES: AnyRecord[] = [
  { prompt: 'a cat' },
  { prompt: 'a cat', images: [IMAGE] },
  { prompt: 'a cat', images: [IMAGE, IMAGE] },
  { prompt: 'a cat', video: VIDEO_INPUT },
  { prompt: 'a cat', resolution: '720p' },
  { prompt: 'a cat', images: [IMAGE], resolution: '720p' },
  { prompt: 'a cat', resolution: '1080p', duration: 10, seed: 42 },
  { prompt: '', images: [IMAGE] },
  { prompt: 'a cat', quantity: 9, cfgScale: 99 },
  // an image-family addon on a video ecosystem: the oracle filters it at parse
  { prompt: 'a cat', resources: [{ id: 222, baseModel: 'SD 1.5', model: { type: 'LORA' } }] },
  // an unknown model id: locked ecosystems (wan) substitute their default,
  // unlocked ones (ltx) keep it
  { prompt: 'a cat', model: 99999 },
  // every version-specific knob at once — fields a family lacks are ignored,
  // the rest exercise their input transforms (snapping, enum refusal, bools)
  {
    prompt: 'a cat',
    shift: 15,
    steps: 55,
    interpolatorModel: 'film',
    usePrime: true,
    draft: true,
    enablePromptEnhancer: false,
    generateAudio: false,
    duration: 3,
    cannyLowThreshold: 0.5,
    guideStrength: 0.9,
    numFrames: 60,
  },
];

/**
 * LTXV23 only: same-version model picks. On other LTX versions these models
 * cross-version-switch in v1 (the branch re-pick the port deliberately does
 * not do yet — see the plan doc); on wan they hit the locked substitution,
 * which the unknown-id shape above already covers.
 */
const LTXV23_ONLY_SHAPES: AnyRecord[] = [
  // the DISTILLED version hides cfgScale/steps
  { prompt: 'a cat', model: { id: 2749948, baseModel: 'LTXV 2.3' } },
  // Sulphur 2 rides the LTXV23 ecosystem
  { prompt: 'a cat', model: { id: 2921800, baseModel: 'LTXV 2.3' } },
];

const WORKFLOWS = ['txt2vid', 'img2vid', 'img2vid:ref2vid', 'vid2vid:edit', 'vid2vid:extend'];
const ECOSYSTEMS = [...ecosystemToVersionDef.keys(), 'LTXV2', 'LTXV23', 'LTXV25', 'Seedance'];

const port = { parse: (raw: AnyRecord, ext: never) => generationHub.parse(raw, ext as never) };

type Combo = { name: string; input: AnyRecord; ext: GenerationCtx };

const COMBOS: Combo[] = [];
for (const [ctxName, ctx] of CONTEXTS) {
  for (const ecosystem of ECOSYSTEMS) {
    const eco = ecosystemByKey.get(ecosystem);
    if (!eco) continue;
    for (const workflow of WORKFLOWS) {
      if (!isWorkflowAvailable(workflow, eco.id)) continue;
      const shapes =
        ecosystem === 'LTXV23' ? [...INPUT_SHAPES, ...LTXV23_ONLY_SHAPES] : INPUT_SHAPES;
      for (const [i, shape] of shapes.entries()) {
        COMBOS.push({
          name: `${ctxName} | ${ecosystem} | ${workflow} | shape${i}`,
          input: { workflow, ecosystem, ...shape },
          ext: ctx,
        });
      }
    }
  }
}

describe('video slice: differential parity with generationGraph', () => {
  it('covers every supported ecosystem x workflow x input shape x context', () => {
    // Guards the generator itself: a mis-wired filter that silently produced a
    // handful of cases would make the suite below vacuously green.
    expect(COMBOS.length).toBeGreaterThan(800);
    expect(new Set(COMBOS.map((c) => c.input.ecosystem)).size).toBeGreaterThanOrEqual(13);
  });

  it.each(COMBOS)('$name', ({ input, ext }) => {
    assertDifferential(port, { name: JSON.stringify(input), input }, ext);
  });

  it('the DATA TYPE tells the wire truth: no backendEcosystem, ecosystem carries its type', () => {
    type Assert<T extends true> = T;
    type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
      ? true
      : false;
    const result = generationHub.parse(
      { workflow: 'txt2vid', ecosystem: 'LTXV23', prompt: 'x' },
      BASE as never
    );
    if (!result.success) throw new Error('unexpected');
    type Data = typeof result.data;
    type _noInternalKey = Assert<
      Equals<'backendEcosystem' extends keyof Data ? true : false, false>
    >;
    // the wire key carries the emitting computed's type
    type _wireEcosystem = Assert<Equals<Data['ecosystem'], string>>;
    expect((result.data as Record<string, unknown>).backendEcosystem).toBeUndefined();
    expect(typeof (result.data as Record<string, unknown>).ecosystem).toBe('string');
  });

  it('resolves Wan 2.1 I2V to the resolution-matched ecosystem', () => {
    // The one place form-graph's single-pass resolution needed an explicit
    // fixed point: `ecosystem` resolves before `resolution`, but v2.1's I2V
    // ecosystem depends on it. Pinned in both directions.
    const at = (resolution: string) =>
      (
        generationHub.parse(
          {
            workflow: 'img2vid',
            ecosystem: 'WanVideo14B_T2V',
            prompt: 'a cat',
            images: [IMAGE],
            resolution,
          },
          BASE as never
        ) as { success: true; data: AnyRecord }
      ).data.ecosystem;
    expect(at('480p')).toBe('WanVideo14B_I2V_480p');
    expect(at('720p')).toBe('WanVideo14B_I2V_720p');

    const oracleAt = (resolution: string) =>
      runOracle(
        {
          workflow: 'img2vid',
          ecosystem: 'WanVideo14B_T2V',
          prompt: 'a cat',
          images: [IMAGE],
          resolution,
        },
        BASE
      ).data.ecosystem;
    expect(at('480p')).toBe(oracleAt('480p'));
    expect(at('720p')).toBe(oracleAt('720p'));
  });
});
