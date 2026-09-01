import { describe, expect, it } from 'vitest';
import { assertDifferential, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
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
 * SD-family only: a model whose baseModel belongs to ANOTHER ecosystem drags
 * the effective ecosystem with it (v1's checkpoint effect). Cross-FAMILY model
 * switching (an SD model on Chroma flipping the whole family) is out of the
 * port's scope so far, so these shapes only run where the switch stays inside
 * the SD family.
 */
const SD_ONLY_SHAPES: AnyRecord[] = [
  { prompt: 'a cat', model: { id: 128713, baseModel: 'SD 1.5' } },
  { prompt: 'a cat', model: { id: 128713, baseModel: 'SD 1.5' }, aspectRatio: '16:9' },
];

const SD_FAMILY = new Set(['SD1', 'SDXL', 'Pony', 'Illustrious', 'NoobAI']);

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
  'SD1',
  'SDXL',
  'Pony',
  'Illustrious',
  'NoobAI',
  'ZImageTurbo',
  'ZImageBase',
  'Chroma',
];

const port = { parse: (raw: AnyRecord, ext: never) => generationHub.parse(raw, ext as never) };

type Combo = { name: string; input: AnyRecord; ext: GenerationCtx };

const COMBOS: Combo[] = [];
for (const [ctxName, ctx] of CONTEXTS) {
  for (const ecosystem of ECOSYSTEMS) {
    const eco = ecosystemByKey.get(ecosystem);
    if (!eco) continue;
    for (const workflow of WORKFLOWS) {
      if (!isWorkflowAvailable(workflow, eco.id)) continue;
      const shapes = SD_FAMILY.has(ecosystem) ? [...INPUT_SHAPES, ...SD_ONLY_SHAPES] : INPUT_SHAPES;
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
    expect(new Set(COMBOS.map((c) => c.input.ecosystem)).size).toBe(ECOSYSTEMS.length);
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
