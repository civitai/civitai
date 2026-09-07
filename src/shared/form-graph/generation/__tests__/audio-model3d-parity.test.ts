import { describe, expect, it } from 'vitest';
import { assertDifferential, runOracle, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * Differential parity for the ported AUDIO and MODEL3D slices against the live
 * `generationGraph.safeParse`, generated the same way as the image/video
 * suites: ecosystem x supported workflow x input shape x external context.
 *
 * The 3D ecosystems other than PolyGen are feature-flag gated (fail-closed),
 * so the base context enables their flags; the `gated` context withholds them
 * to pin the hidden-fallback path.
 */

const FLAGS_3D = {
  tripoGenerator: true,
  hunyuan3dGenerator: true,
  pixal3dGenerator: true,
  trellis2Generator: true,
} as GenerationCtx['flags'];

const BASE: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: FLAGS_3D,
  gateRules: [],
};

const CONTEXTS: [string, GenerationCtx][] = [
  ['base', BASE],
  ['wildcards', { ...BASE, flags: { ...FLAGS_3D, wildcards: true } as GenerationCtx['flags'] }],
  [
    'meshyV7',
    { ...BASE, flags: { ...FLAGS_3D, meshyV7Generator: true } as GenerationCtx['flags'] },
  ],
  [
    'freeTier',
    {
      ...BASE,
      user: { isMember: false, tier: 'free' },
      limits: { maxQuantity: 1, maxResources: 1, vidQuantity: 1 },
    },
  ],
  // no 3D flags at all: flag-gated ecosystems are hidden, stale selections
  // fall back to the default (PolyGen)
  ['unflagged', { ...BASE, flags: {} as GenerationCtx['flags'] }],
];

const IMAGE = { url: 'https://example.com/a.png', width: 1280, height: 720 };

const AUDIO_SHAPES: AnyRecord[] = [
  { prompt: 'an upbeat song' },
  { prompt: '' },
  { prompt: 'an upbeat song', seed: 42, duration: 45 },
  { prompt: 'an upbeat song', duration: 9999 },
  // custom mode: full control surface; missing required editors
  {
    aceAudioMode: 'custom',
    minimaxMusicMode: 'custom',
    musicDescription: 'synthwave with heavy bass',
    lyrics: '[Verse] la la la',
    title: 'Test Track',
    bpm: 128,
    cfgScale: 2,
    steps: 12,
    instrumentalWeight: 0.7,
    vocalWeight: 0.2,
  },
  { aceAudioMode: 'custom', minimaxMusicMode: 'custom' },
  { aceAudioMode: 'custom', minimaxMusicMode: 'custom', musicDescription: 'jazz', bpm: 500 },
  // cover image vs generateCover (Ace); ignored fields elsewhere
  { prompt: 'an upbeat song', images: [IMAGE] },
  { prompt: 'an upbeat song', generateCover: true, images: [IMAGE] },
  // model picks: a real Ace version, an unknown id
  { prompt: 'an upbeat song', model: 2864864 },
  { prompt: 'an upbeat song', model: 99999 },
];

const MODEL3D_SHAPES: AnyRecord[] = [
  { prompt: 'a treasure chest' },
  { prompt: '' },
  { images: [IMAGE] },
  { prompt: 'a treasure chest', images: [IMAGE] },
  { images: [IMAGE, IMAGE] },
  {
    images: [IMAGE],
    shouldTexture: false,
    shouldRemesh: false,
    enablePbr: true,
    seed: 42,
  },
  // polygen knobs (ignored elsewhere); v7 pick is flag- and workflow-gated
  {
    images: [IMAGE],
    polygenVersion: 'v7',
    poseMode: 'a-pose',
    ultraMode: true,
    modelType: 'lowpoly',
    enableAnimation: true,
    riggingHeightMeters: 2,
    animationActionId: 3,
  },
  { prompt: 'a treasure chest', polygenVersion: 'v7', polygenMode: 'preview' },
  {
    images: [IMAGE],
    targetPolycount: 999_999,
    topology: 'quad',
    symmetryMode: 'on',
    texturePrompt: 'weathered oak',
    enableRigging: true,
  },
  // tripo / hunyuan3d knobs (ignored elsewhere)
  {
    images: [IMAGE],
    texture: 'HD',
    pbr: true,
    quad: true,
    autoSize: true,
    faceLimit: 20_000,
    textureAlignment: 'geometry',
    orientation: 'align_image',
    textureSeed: 7,
  },
  {
    images: [IMAGE],
    hunyuanPrompt: 'shiny metal',
    hunyuanModelVersion: 'v2',
    hunyuanSteps: 45,
    hunyuanCfgScale: 7.5,
    hunyuanOctreeResolution: 512,
  },
  { images: [IMAGE], faceLimit: 5 },
];

const AUDIO_ECOSYSTEMS = ['Ace', 'MiniMaxMusic3'];
const MODEL3D_ECOSYSTEMS = ['PolyGen', 'Tripo', 'Hunyuan3D', 'Pixal3D', 'Trellis2'];

const SLICES: Array<{ ecosystems: string[]; workflows: string[]; shapes: AnyRecord[] }> = [
  { ecosystems: AUDIO_ECOSYSTEMS, workflows: ['txt2music'], shapes: AUDIO_SHAPES },
  {
    ecosystems: MODEL3D_ECOSYSTEMS,
    workflows: ['txt2model3d', 'img2model3d'],
    shapes: MODEL3D_SHAPES,
  },
];

const port = {
  parse: (raw: AnyRecord, ext: never) => generationHub.parse(reconcileSelectors(raw).raw, ext),
};

type Combo = { name: string; input: AnyRecord; ext: GenerationCtx };

const COMBOS: Combo[] = [];
for (const [ctxName, ctx] of CONTEXTS) {
  for (const { ecosystems, workflows, shapes } of SLICES) {
    for (const ecosystem of ecosystems) {
      const eco = ecosystemByKey.get(ecosystem);
      if (!eco) continue;
      for (const workflow of workflows) {
        if (!isWorkflowAvailable(workflow, eco.id)) continue;
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
}

describe('audio + model3d slices: differential parity with generationGraph', () => {
  it('covers every supported ecosystem x workflow x input shape x context', () => {
    expect(COMBOS.length).toBeGreaterThan(300);
    const covered = new Set(COMBOS.map((c) => c.input.ecosystem));
    const all = [...AUDIO_ECOSYSTEMS, ...MODEL3D_ECOSYSTEMS];
    expect(all.filter((e) => !covered.has(e))).toEqual([]);
    expect(all.filter((e) => !ecosystemByKey.has(e))).toEqual([]);
  });

  it.each(COMBOS)('$name', ({ input, ext }) => {
    assertDifferential(port, { name: JSON.stringify(input), input }, ext);
  });

  it('sanity: the oracle actually serves these slices (guards the whole matrix)', () => {
    const audio = runOracle({ workflow: 'txt2music', ecosystem: 'Ace', prompt: 'x' }, BASE);
    expect(audio.success).toBe(true);
    const m3d = runOracle({ workflow: 'img2model3d', ecosystem: 'PolyGen', images: [IMAGE] }, BASE);
    expect(m3d.success).toBe(true);
  });
});
