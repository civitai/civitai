import { describe, expect, it } from 'vitest';

import {
  BUDGET_BY_ENGINE,
  ESTIMATE_BUZZ_BY_ENGINE,
  PANO_HEIGHT,
  PANO_WIDTH,
  PROMPT_MAX,
  SEAMLESS_PANO_ENGINES,
  SEAM_BAND_PX,
  SEAM_DENOISE,
  SEAM_FEATHER_PX,
  ZIMAGE_CLIP_AIR,
  ZIMAGE_DIFFUSION_AIR,
  ZIMAGE_LORA_AIR,
  ZIMAGE_LORA_VERSION_ID,
  ZIMAGE_TRIGGER_WORDS,
  ZIMAGE_VAE_AIR,
  buildZimageSeamlessGraph,
  seamlessPano360Recipe,
  seamlessPanoParamSchema,
  type SeamlessPanoParams,
} from '../seamless-pano.recipe';
import {
  REGISTERED_RECIPE_IDS,
  getRecipe,
  recipeCivitaiVersionIds,
  type ComfyGraph,
  type CustomComfyStepInput,
} from '../index';

// The recipe builders take the recipe's OWN param type. These helpers mirror the
// reference oracle's `buildPanoBody(prompt, seed, _, { engine })` fixtures.
const params = (
  prompt: string,
  seed?: number,
  engine?: SeamlessPanoParams['engine']
): SeamlessPanoParams => ({
  prompt,
  ...(seed !== undefined ? { seed } : {}),
  ...(engine ? { engine } : {}),
});

const QUALITY_TAIL = ', ultra detailed, masterpiece, best quality';

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN-GRAPH ORACLE — the assertions below are ported byte-for-byte from
// Koen's `panorama.test.ts`. A ported builder that drifts from the reference
// graph (a wrong link ref, class_type, or widget) fails here.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildZimageSeamlessGraph (golden: Z-Image DiT engine)', () => {
  const graph = buildZimageSeamlessGraph(params('an icy lake', 42, 'zimage-turbo'));

  it('mirrors the worker Z-Image recipe: split loaders, lumina2 clip, shift 3', () => {
    expect(graph['1']).toEqual({
      class_type: 'UNETLoader',
      inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
    });
    expect(graph['2'].class_type).toBe('LoraLoaderModelOnly');
    expect(graph['2'].inputs.lora_name).toBe(ZIMAGE_LORA_AIR);
    expect(graph['3']).toEqual({
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['2', 0], shift: 3.0 },
    });
    expect(graph['4'].inputs).toMatchObject({ clip_name: ZIMAGE_CLIP_AIR, type: 'lumina2' });
    expect(graph['7'].inputs.vae_name).toBe(ZIMAGE_VAE_AIR);
    expect(graph['8'].class_type).toBe('EmptySD3LatentImage');
  });

  it('turbo sampling: 8 steps, cfg 1, euler/simple, inert negative', () => {
    expect(graph['9'].inputs).toMatchObject({
      seed: 42,
      steps: 8,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1.0,
    });
    expect(graph['5'].inputs.text).toBe(ZIMAGE_TRIGGER_WORDS + 'an icy lake' + QUALITY_TAIL);
    expect(graph['6'].inputs.text).toBe('');
  });

  it('rolls 50% via crop+stitch with the halves swapped (seam to center)', () => {
    const half = PANO_WIDTH / 2;
    expect(graph['11'].inputs).toMatchObject({ image: ['10', 0], x: 0, width: half });
    expect(graph['12'].inputs).toMatchObject({ image: ['10', 0], x: half, width: half });
    expect(graph['13'].class_type).toBe('ImageStitch');
    expect(graph['13'].inputs.image1).toEqual(['12', 0]);
    expect(graph['13'].inputs.image2).toEqual(['11', 0]);
    expect(graph['13'].inputs.direction).toBe('right');
  });

  it('builds a centered feathered band mask', () => {
    expect(graph['14'].inputs).toMatchObject({ value: 0, width: PANO_WIDTH, height: PANO_HEIGHT });
    expect(graph['15'].inputs).toMatchObject({ value: 1, width: SEAM_BAND_PX });
    expect(graph['16'].inputs).toMatchObject({
      x: (PANO_WIDTH - SEAM_BAND_PX) / 2,
      operation: 'add',
    });
    expect(graph['17'].inputs).toMatchObject({ left: SEAM_FEATHER_PX, right: SEAM_FEATHER_PX });
  });

  it('heals the band with a partial-denoise pass and rolls back', () => {
    expect(graph['18']).toEqual({
      class_type: 'VAEEncode',
      inputs: { pixels: ['13', 0], vae: ['7', 0] },
    });
    expect(graph['19']).toEqual({
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['18', 0], mask: ['17', 0] },
    });
    expect(graph['20'].inputs).toMatchObject({
      latent_image: ['19', 0],
      denoise: SEAM_DENOISE,
      seed: 43,
      cfg: 1,
    });
    expect(graph['21'].inputs.samples).toEqual(['20', 0]);
    expect(graph['22'].inputs.image).toEqual(['21', 0]);
    expect(graph['24'].inputs.image1).toEqual(['23', 0]);
    expect(graph['25']).toMatchObject({ class_type: 'SaveImage', inputs: { images: ['24', 0] } });
  });

  it('randomizes the seed when omitted', () => {
    const g = buildZimageSeamlessGraph(params('a lake', undefined, 'zimage-turbo'));
    const seed = g['9'].inputs.seed as number;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection safety — a prompt with graph-hostile bytes yields a STRUCTURALLY
// identical graph (object construction; prompt is a leaf). Plan §7-3.
// ─────────────────────────────────────────────────────────────────────────────
describe('prompt injection safety', () => {
  const MALICIOUS = 'a lake", "class_type": "Evil"}, "999": {{ </script> \\ \0 end';

  const structure = (g: ComfyGraph) =>
    Object.fromEntries(Object.entries(g).map(([id, n]) => [id, n.class_type]));

  it.each(SEAMLESS_PANO_ENGINES)(
    '%s: hostile prompt does not perturb graph topology, lands as a leaf',
    (engine) => {
      const benign = buildZimageSeamlessGraph(params('a lake', 7, engine));
      const hostile = buildZimageSeamlessGraph(params(MALICIOUS, 7, engine));
      const positive = '5';

      // Same node ids + class_types → identical topology.
      expect(structure(hostile)).toEqual(structure(benign));
      // The prompt text node differs ONLY in its leaf `text` value.
      expect(hostile[positive].inputs.text).toContain(MALICIOUS);
      expect(hostile[positive].inputs.text).not.toBe(benign[positive].inputs.text);
      // The malicious bytes never become graph structure — they survive a JSON
      // round-trip as a single string value, escaped.
      const revived = JSON.parse(JSON.stringify(hostile)) as ComfyGraph;
      expect(structure(revived)).toEqual(structure(benign));
      expect(revived[positive].inputs.text).toContain(MALICIOUS);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// buildStep — engine dispatch + resource ordering (mirrors buildDitSeamlessTemplate).
// ─────────────────────────────────────────────────────────────────────────────
describe('recipe.buildStep (engine → resources + graph)', () => {
  const build = (p: SeamlessPanoParams): CustomComfyStepInput =>
    seamlessPano360Recipe.buildStep(p, {});

  it('defaults to zimage-turbo when engine is omitted', () => {
    const step = build(params('a lake', 1));
    expect(step.trace).toBe('binary');
    expect(step.resources).toEqual([
      ZIMAGE_DIFFUSION_AIR,
      ZIMAGE_CLIP_AIR,
      ZIMAGE_VAE_AIR,
      ZIMAGE_LORA_AIR,
    ]);
    expect(step.workflow['1'].class_type).toBe('UNETLoader');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Param schema — bounded + strict, no checkpoint (pinned policy).
// ─────────────────────────────────────────────────────────────────────────────
describe('seamlessPanoParamSchema', () => {
  it('accepts the bounded shape', () => {
    const r = seamlessPanoParamSchema.safeParse({
      prompt: 'x',
      seed: 5,
      engine: 'zimage-turbo',
      accountType: 'blue',
    });
    expect(r.success).toBe(true);
  });
  it('rejects a prompt over the cap', () => {
    expect(seamlessPanoParamSchema.safeParse({ prompt: 'x'.repeat(PROMPT_MAX + 1) }).success).toBe(
      false
    );
  });
  it.each(['sdxl', 'qwen-image', 'flux2-klein'])('rejects the engine %s', (engine) => {
    expect(seamlessPanoParamSchema.safeParse({ prompt: 'x', engine }).success).toBe(false);
  });
  it('rejects a checkpoint field (v1 pinned policy — .strict())', () => {
    expect(
      seamlessPanoParamSchema.safeParse({ prompt: 'x', checkpoint: { modelId: 1, versionId: 2 } })
        .success
    ).toBe(false);
  });
  it('coerces a string seed and tolerates null', () => {
    expect(seamlessPanoParamSchema.parse({ prompt: 'x', seed: '9' }).seed).toBe(9);
    expect(seamlessPanoParamSchema.parse({ prompt: 'x', seed: null }).seed).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipe contract + registry wiring.
// ─────────────────────────────────────────────────────────────────────────────
describe('seamlessPano360Recipe contract', () => {
  it('is registered under its id and reachable via getRecipe', () => {
    expect(REGISTERED_RECIPE_IDS).toContain('seamless-pano-360');
    expect(getRecipe('seamless-pano-360')).toBe(seamlessPano360Recipe);
    expect(getRecipe('not-a-recipe')).toBeUndefined();
  });

  it('declares the per-engine post-paid ceiling contract: maxBuzz == ceil(stepTimeoutSeconds) for EVERY engine', () => {
    // v1.1: the timeout==ceiling invariant now holds PER ENGINE (the module-load
    // loop in index.ts asserts this too — re-assert it here as the recipe's own
    // contract test so a bad table entry fails loudly in the recipe suite).
    for (const engine of SEAMLESS_PANO_ENGINES) {
      const budget = BUDGET_BY_ENGINE[engine];
      expect(budget.maxBuzz).toBe(Math.ceil(budget.stepTimeoutSeconds));
    }
  });

  it('resolves the budget from params, default → zimage 90', () => {
    expect(seamlessPano360Recipe.budgetFor(params('x'))).toEqual({
      maxBuzz: 90,
      stepTimeoutSeconds: 90,
    });
    // An unknown engine falls back to the default engine's budget (defensive; the
    // .strict() schema already rejects unknown engines before this is reached).
    expect(seamlessPano360Recipe.budgetForEngine('not-an-engine')).toEqual(
      BUDGET_BY_ENGINE['zimage-turbo']
    );
  });

  it('is pinned (no user checkpoint) and pins the 360Redmond LoRA version', () => {
    expect(seamlessPano360Recipe.checkpointPolicy).toBe('pinned');
    expect(seamlessPano360Recipe.resourceAllowlist.checkpoints).toBeUndefined();
    expect(recipeCivitaiVersionIds(seamlessPano360Recipe)).toEqual([ZIMAGE_LORA_VERSION_ID]);
  });

  it('surfaces the display estimate', () => {
    expect(seamlessPano360Recipe.estimateBuzz(params('x'))).toBe(
      ESTIMATE_BUZZ_BY_ENGINE['zimage-turbo']
    );
  });
});
