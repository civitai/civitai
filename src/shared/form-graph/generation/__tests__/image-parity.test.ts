import { describe, expect, it } from 'vitest';
import { assertDifferential, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * Differential parity for the ported image slice (SD family + ZImage + Chroma
 * + the image hub head fields) against the live `generationGraph.safeParse`,
 * driven through the composed root. Same generated-matrix approach as the
 * video suite.
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
  ['sdcppBogo', { ...BASE, flags: { enhancedCompatibilitySdcpp: true } as GenerationCtx['flags'] }],
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
          id: 'test-hide-chroma',
          name: 'hide Chroma',
          availableTo: 'nobody',
          presentation: 'hidden',
          ecosystems: ['Chroma'],
          workflows: [],
          modelVersionIds: [],
        },
        {
          id: 'test-disable-draft',
          name: 'disable draft',
          availableTo: 'nobody',
          presentation: 'disabled',
          ecosystems: [],
          workflows: ['txt2img:draft'],
          modelVersionIds: [],
        },
      ] as GenerationCtx['gateRules'],
    },
  ],
];

const IMAGE = { url: 'https://example.com/a.png', width: 1216, height: 832 };
const CN_IMAGE = { url: 'https://example.com/cn.png', width: 512, height: 512 };

const INPUT_SHAPES: AnyRecord[] = [
  { prompt: 'a cat' },
  { prompt: 'a cat', images: [IMAGE] },
  { prompt: '', images: [IMAGE] },
  { prompt: '' },
  { prompt: 'a cat', aspectRatio: '16:9', seed: 42 },
  { prompt: 'a cat', sampler: 'DPM++ 2M Karras', cfgScale: 99, steps: 999 },
  { prompt: 'a cat', sampler: 'not-a-sampler', scheduler: 'discrete' },
  { prompt: 'a cat', quantity: 9, priority: 'high', outputFormat: 'png' },
  { prompt: 'a cat', clipSkip: 3, denoise: 0.5 },
  { prompt: 'a cat', controlNets: [{ preprocessor: 'canny', image: CN_IMAGE }] },
  { prompt: 'a cat', negativePrompt: 'blurry' },
  { prompt: 'a cat', model: 12345 },
  // one compatible + one incompatible addon: the oracle FILTERS at parse time
  {
    prompt: 'a cat',
    resources: [
      { id: 111, baseModel: 'SDXL 1.0', model: { type: 'LORA' } },
      { id: 222, baseModel: 'SD 1.5', model: { type: 'LORA' } },
    ],
  },
  // incompatible VAE: cleared at parse time (families without a vae field drop the key)
  { prompt: 'a cat', vae: { id: 333, baseModel: 'SD 1.5', model: { type: 'VAE' } } },
];

/**
 * Cross-ecosystem models: the MODEL WINS (v1's checkpoint effect). With
 * `reconcileSelectors` at the boundary this now holds across FAMILIES too —
 * an SD checkpoint on Chroma parses as SD1 — so these shapes run on every
 * image ecosystem.
 */
/** Boundary shape: a 1-char prompt pins min-length-rule drift between lanes. */
const BOUNDARY_SHAPES: AnyRecord[] = [{ prompt: 'a' }];

const CROSS_MODEL_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: { id: 128713, baseModel: 'SD 1.5' } },
  { prompt: 'a cat', model: { id: 128713, baseModel: 'SD 1.5' }, aspectRatio: '16:9' },
];

/**
 * Flux-family only: mode selection by version id, and both directions of the
 * draft workflow<->model coupling (the workflow wins at parse — probed).
 */
const FLUX_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 699279 }, // draft model on txt2img -> snapped to standard
  { prompt: 'a cat', model: 922358 }, // pro
  { prompt: 'a cat', model: 1088507, aspectRatio: '21:9' }, // ultra + its AR table
  { prompt: 'a cat', model: 2068000 }, // krea
  { prompt: 'a cat', model: 691639 }, // standard, explicit
];
/** Ernie turbo + Seedream versions: mode/toggle selection by version id. */
const ERNIE_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2863892 }, // turbo: no resources arm
];
const SEEDREAM_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2208174 }, // v3: no resolution toggle
  { prompt: 'a cat', model: 2470991, resolution: '2K' }, // v4.5: toggle + 2K dims
  { prompt: 'a cat', model: 2720141, aspectRatio: '16:9' }, // v5.0-lite at 4K default
];

const IMG = { url: 'https://example.com/a.png', width: 1216, height: 832 };

/** WanImage 2.7 + Grok (image half): version-gated fields, edit images. */
const WANIMAGE_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', negativePrompt: 'blurry', enablePromptEnhancer: true },
  { prompt: 'a cat', aspectRatio: '16:9', cfgScale: 6 },
];
const GROK_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2738377 }, // v1.0 explicit
  { prompt: 'a cat', aspectRatio: '3:2' },
];

/** Nano Banana: four modes by version id, resolution-scaled dims. */
const NANOBANANA_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2436219, resolution: '2K', aspectRatio: '16:9' }, // pro
  { prompt: 'a cat', model: 2725610, enableWebSearch: true }, // v2
  { prompt: 'a cat', model: 3086021 }, // v2 lite
];

/** Qwen: workflow-scoped versions hit the lock (substitute to default). */
const QWEN_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2110043 }, // txt v2509 explicit
  { prompt: 'a cat', model: 2133258 }, // img2img version on txt rows -> default
];

/** OpenAI gpt1 (transparency toggle) + Lens turbo and resolution tiers. */
const OPENAI_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 1733399, transparent: true, quality: 'low' }, // gpt1
  { prompt: 'a cat', model: 2512167 }, // v1.5 -> gpt1
  { prompt: 'a cat', quality: 'medium' }, // default v2 -> gpt2
];
const LENS_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2982241 }, // turbo ranges
  { prompt: 'a cat', resolution: '1440', aspectRatio: '16:9' },
];

/** HiDream variants (fast/full at both precisions) + O1's full/dev + tiers. */
const HIDREAM_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 1770945 }, // fp8 fast: no cfg/steps/resources
  { prompt: 'a cat', model: 1772448 }, // fp8 full: everything
  { prompt: 'a cat', model: 1768731 }, // fp16 fast
];
const HIDREAMO1_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2939946 }, // full defaults
  { prompt: 'a cat', resolution: '2K', aspectRatio: '16:9' },
];

/** Anima turbo variant + MageFlow's workflow-scoped versions. */
const ANIMA_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 3108589 }, // turbo ranges
  { prompt: 'a cat', sampler: 'dpmpp_2m', scheduler: 'sgm_uniform' },
];
const MAGEFLOW_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 3172039 }, // txt turbo
  { prompt: 'a cat', model: 3172043, images: [IMG] }, // edit model -> workflow follows
];

/** Kontext + Flux2 mode selection by version id (Klein modes are ecosystems). */
const KONTEXT_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 1892509 }, // pro
  { prompt: 'a cat', model: 1892523, aspectRatio: '21:9' }, // max + kontext AR table
];
/** Boogu: workflow-scoped versions — the model wins the workflow (probed). */
const BOOGU_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 3050010 }, // turbo (no negativePrompt, turbo ranges)
  { prompt: 'a cat', model: 3049824, images: [IMG] }, // edit model -> workflow follows
  { prompt: 'a cat', model: 3113427, images: [IMG] }, // editTurbo -> workflow follows
  { prompt: 'a cat', model: 3049541 }, // base explicit (on edit rows: workflow -> txt2img)
];

/** Krea2: FAL tiers vs comfy builds; edit substitutes non-comfy versions. */
const KREA2_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2983023 }, // fal medium: creativity + styleReferences
  { prompt: 'a cat', model: 2983022, creativity: 'high' }, // fal large
  {
    prompt: 'a cat',
    model: 2983023,
    styleReferences: [{ image: 'https://example.com/s.png', strength: 0.7 }, {}],
  },
  { prompt: 'a cat', model: 3072332 }, // comfy turbo
  { prompt: 'a cat', model: 2983023, images: [IMG] }, // fal model where edit rows substitute
];

const FLUX2_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: 2439067 }, // dev (resources arm)
  { prompt: 'a cat', model: 2439047 }, // flex
  { prompt: 'a cat', model: 2439442 }, // pro
  { prompt: 'a cat', model: 2547175 }, // max
];

const WORKFLOWS = [
  'txt2img',
  'txt2img:draft',
  'txt2img:face-fix',
  'txt2img:hires-fix',
  'img2img',
  'img2img:face-fix',
  'img2img:hires-fix',
  'img2img:edit',
];

// SD2 is in the SD family's discriminator but supports no generation
// workflows any more, so it can produce no matrix rows.
const ECOSYSTEMS = [
  'Flux1',
  'FluxKrea',
  'SD1',
  'SDXL',
  'Pony',
  'Illustrious',
  'NoobAI',
  'ZImageTurbo',
  'ZImageBase',
  'Chroma',
  'Flux1Kontext',
  'Flux2',
  'Flux2Klein_9B',
  'Flux2Klein_9B_base',
  'Flux2Klein_4B',
  'Flux2Klein_4B_base',
  'Boogu',
  'Krea2',
  'Imagen4',
  'PonyV7',
  'Reve',
  'MuseImage',
  'MAI',
  'Ernie',
  'Seedream',
  'Anima',
  'MageFlow',
  'HiDream',
  'HiDream-O1',
  'OpenAI',
  'Lens',
  'Qwen',
  'Qwen2',
  'Qwen3',
  'NanoBanana',
  'WanImage27',
  'Grok',
];

// the port's boundary = reconcile + parse, exactly as the server adapter composes it
const port = {
  parse: (raw: AnyRecord, ext: never) => generationHub.parse(reconcileSelectors(raw).raw, ext),
};

/**
 * Family-specific extra shapes, keyed by ecosystem. A RECORD rather than a
 * ternary chain so a typo'd key fails the canary by name instead of silently
 * running zero extra shapes.
 */
const EXTRA_SHAPES: Record<string, AnyRecord[]> = {
  NanoBanana: NANOBANANA_ONLY_SHAPES,
  Qwen: QWEN_ONLY_SHAPES,
  OpenAI: OPENAI_ONLY_SHAPES,
  Lens: LENS_ONLY_SHAPES,
  HiDream: HIDREAM_ONLY_SHAPES,
  'HiDream-O1': HIDREAMO1_ONLY_SHAPES,
  Anima: ANIMA_ONLY_SHAPES,
  MageFlow: MAGEFLOW_ONLY_SHAPES,
  Ernie: ERNIE_ONLY_SHAPES,
  Seedream: SEEDREAM_ONLY_SHAPES,
  Boogu: BOOGU_ONLY_SHAPES,
  Krea2: KREA2_ONLY_SHAPES,
  Flux1Kontext: KONTEXT_ONLY_SHAPES,
  Flux2: FLUX2_ONLY_SHAPES,
  Flux1: FLUX_ONLY_SHAPES,
  FluxKrea: FLUX_ONLY_SHAPES,
  WanImage27: WANIMAGE_ONLY_SHAPES,
  Grok: GROK_ONLY_SHAPES,
};

type Combo = { name: string; input: AnyRecord; ext: GenerationCtx };

const COMBOS: Combo[] = [];
for (const [ctxName, ctx] of CONTEXTS) {
  for (const ecosystem of ECOSYSTEMS) {
    const eco = ecosystemByKey.get(ecosystem);
    if (!eco) continue;
    for (const workflow of WORKFLOWS) {
      if (!isWorkflowAvailable(workflow, eco.id)) continue;
      const shapes = [
        ...INPUT_SHAPES,
        ...BOUNDARY_SHAPES,
        ...CROSS_MODEL_SHAPES,
        ...(EXTRA_SHAPES[ecosystem] ?? []),
      ];
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

describe('image slice: differential parity with generationGraph', () => {
  it('covers every supported ecosystem x workflow x input shape x context', () => {
    expect(COMBOS.length).toBeGreaterThan(500);
    const covered = new Set(COMBOS.map((c) => c.input.ecosystem));
    expect(ECOSYSTEMS.filter((e) => !covered.has(e))).toEqual([]);
    // every ECOSYSTEMS entry must resolve in the constants, or its rows
    // silently vanished from the matrix
    expect(ECOSYSTEMS.filter((e) => !ecosystemByKey.has(e))).toEqual([]);
    // every family-specific shape list must be keyed by a REAL matrix
    // ecosystem — a typo here is zero extra shapes, invisibly
    expect(Object.keys(EXTRA_SHAPES).filter((k) => !ECOSYSTEMS.includes(k))).toEqual([]);
  });

  it.each(COMBOS)('$name', ({ input, ext }) => {
    assertDifferential(port, { name: JSON.stringify(input), input }, ext);
  });
});

describe('incompatible workflow x ecosystem combos redirect like the oracle', () => {
  // v1's sync effect: an ecosystem that doesn't support the workflow parses
  // as the workflow's configured default. Only combos whose redirect TARGET
  // is a ported family can assert full parity.
  const CROSS_COMBOS = [
    { workflow: 'txt2img', ecosystem: 'WanVideo30' },
    { workflow: 'txt2img', ecosystem: 'LTXV23' },
    { workflow: 'txt2img', ecosystem: 'Seedance' },
    { workflow: 'txt2img:draft', ecosystem: 'WanVideo-25-T2V' },
  ];
  it.each(CROSS_COMBOS)('$workflow x $ecosystem', ({ workflow, ecosystem }) => {
    assertDifferential(
      port,
      { name: `${workflow} x ${ecosystem}`, input: { workflow, ecosystem, prompt: 'a cat' } },
      BASE
    );
  });
});
