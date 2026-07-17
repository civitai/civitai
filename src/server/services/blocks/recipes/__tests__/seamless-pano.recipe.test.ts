import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_BUZZ_BY_ENGINE,
  FLUX2_CFG,
  FLUX2_CLIP_AIR,
  FLUX2_DIFFUSION_AIR,
  FLUX2_LORA_AIR,
  FLUX2_LORA_VERSION_ID,
  FLUX2_STEPS,
  FLUX2_TRIGGER_WORDS,
  FLUX2_VAE_AIR,
  NEGATIVE_PROMPT,
  PANO_HEIGHT,
  PANO_WIDTH,
  PROMPT_MAX,
  QWEN_CLIP_AIR,
  QWEN_DIFFUSION_AIR,
  QWEN_LORA_AIR,
  QWEN_LORA_VERSION_ID,
  QWEN_TRIGGER_WORDS,
  QWEN_VAE_AIR,
  SEAM_BAND_PX,
  SEAM_DENOISE,
  SEAM_FEATHER_PX,
  SEAM_STEPS,
  ZIMAGE_CLIP_AIR,
  ZIMAGE_DIFFUSION_AIR,
  ZIMAGE_LORA_AIR,
  ZIMAGE_LORA_VERSION_ID,
  ZIMAGE_TRIGGER_WORDS,
  ZIMAGE_VAE_AIR,
  buildFlux2SeamlessGraph,
  buildQwenSeamlessGraph,
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
const params = (prompt: string, seed?: number, engine?: SeamlessPanoParams['engine']): SeamlessPanoParams => ({
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
    expect(graph['16'].inputs).toMatchObject({ x: (PANO_WIDTH - SEAM_BAND_PX) / 2, operation: 'add' });
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

describe('buildQwenSeamlessGraph (golden: Qwen DiT engine)', () => {
  const graph = buildQwenSeamlessGraph(params('an icy lake', 42, 'qwen-image'));

  it('loads the prod-warm 2512 GGUF with the sdpa attention override', () => {
    expect(graph['1'].class_type).toBe('GGUFLoaderKJ');
    expect(graph['1'].inputs).toMatchObject({ model_name: QWEN_DIFFUSION_AIR, attention_override: 'sdpa' });
    expect(graph['2'].inputs.lora_name).toBe(QWEN_LORA_AIR);
    expect(graph['3'].inputs).toMatchObject({ shift: 3.1 });
    expect(graph['4'].inputs).toMatchObject({ clip_name: QWEN_CLIP_AIR, type: 'qwen_image' });
    expect(graph['7'].inputs.vae_name).toBe(QWEN_VAE_AIR);
  });

  it('quality sampling: 20 steps, cfg 2.5, ACTIVE negative prompt', () => {
    expect(graph['9'].inputs).toMatchObject({
      seed: 42,
      steps: 20,
      cfg: 2.5,
      sampler_name: 'euler',
      scheduler: 'simple',
    });
    expect(graph['5'].inputs.text).toBe(QWEN_TRIGGER_WORDS + 'an icy lake' + QUALITY_TAIL);
    expect(graph['6'].inputs.text).toBe(NEGATIVE_PROMPT);
    expect(graph['20'].inputs).toMatchObject({ cfg: 2.5, denoise: SEAM_DENOISE, seed: 43 });
  });

  it('shares the exact roll/mask/heal node shape with Z-Image (loader aside)', () => {
    const zimage = buildZimageSeamlessGraph(params('an icy lake', 42, 'zimage-turbo'));
    expect(Object.keys(graph)).toEqual(Object.keys(zimage));
    for (const id of Object.keys(graph)) {
      if (id === '1') continue;
      expect(graph[id].class_type).toBe(zimage[id].class_type);
    }
  });
});

describe('buildFlux2SeamlessGraph (golden: Flux2 Klein engine)', () => {
  const graph = buildFlux2SeamlessGraph(params('an icy lake', 42, 'flux2-klein'));

  it('loads the prod 9b-kv model set with the flux2 clip type', () => {
    expect(graph['1']).toEqual({
      class_type: 'UNETLoader',
      inputs: { unet_name: FLUX2_DIFFUSION_AIR, weight_dtype: 'default' },
    });
    expect(graph['2'].inputs.lora_name).toBe(FLUX2_LORA_AIR);
    expect(graph['3'].inputs).toMatchObject({ clip_name: FLUX2_CLIP_AIR, type: 'flux2' });
    expect(graph['6'].inputs.vae_name).toBe(FLUX2_VAE_AIR);
    expect(graph['7'].class_type).toBe('EmptyFlux2LatentImage');
    expect(graph['4'].inputs.text).toBe(FLUX2_TRIGGER_WORDS + 'an icy lake' + QUALITY_TAIL);
    expect(graph['5'].inputs.text).toBe(NEGATIVE_PROMPT);
  });

  it('samples with the fleet stack: Flux2Scheduler + CFGGuider + SamplerCustomAdvanced', () => {
    expect(graph['8']).toEqual({
      class_type: 'Flux2Scheduler',
      inputs: { steps: FLUX2_STEPS, width: PANO_WIDTH, height: PANO_HEIGHT },
    });
    expect(graph['9']).toEqual({
      class_type: 'CFGGuider',
      inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], cfg: FLUX2_CFG },
    });
    expect(graph['10'].inputs.noise_seed).toBe(42);
    expect(graph['12']).toEqual({
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['10', 0], guider: ['9', 0], sampler: ['11', 0], sigmas: ['8', 0], latent_image: ['7', 0] },
    });
    expect(graph['13'].inputs).toEqual({ samples: ['12', 0], vae: ['6', 0] });
  });

  it('seam pass takes its partial denoise from SplitSigmasDenoise low_sigmas', () => {
    expect(graph['23'].inputs).toMatchObject({ steps: SEAM_STEPS });
    expect(graph['24']).toEqual({
      class_type: 'SplitSigmasDenoise',
      inputs: { sigmas: ['23', 0], denoise: SEAM_DENOISE },
    });
    expect(graph['25'].inputs.noise_seed).toBe(43);
    expect(graph['26'].inputs).toEqual({
      noise: ['25', 0],
      guider: ['9', 0],
      sampler: ['11', 0],
      sigmas: ['24', 1],
      latent_image: ['22', 0],
    });
  });

  it('rolls, masks, heals, rolls back, and saves', () => {
    const half = PANO_WIDTH / 2;
    expect(graph['14'].inputs).toMatchObject({ image: ['13', 0], x: 0, width: half });
    expect(graph['15'].inputs).toMatchObject({ image: ['13', 0], x: half, width: half });
    expect(graph['16'].inputs.image1).toEqual(['15', 0]);
    expect(graph['21'].inputs).toEqual({ pixels: ['16', 0], vae: ['6', 0] });
    expect(graph['22'].inputs).toEqual({ samples: ['21', 0], mask: ['20', 0] });
    expect(graph['31']).toMatchObject({ class_type: 'SaveImage', inputs: { images: ['30', 0] } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection safety — a prompt with graph-hostile bytes yields a STRUCTURALLY
// identical graph (object construction; prompt is a leaf). Plan §7-3.
// ─────────────────────────────────────────────────────────────────────────────
describe('prompt injection safety', () => {
  const MALICIOUS = 'a lake", "class_type": "Evil"}, "999": {{ </script> \\   end';

  const structure = (g: ComfyGraph) => Object.fromEntries(Object.entries(g).map(([id, n]) => [id, n.class_type]));

  it.each(['zimage-turbo', 'qwen-image', 'flux2-klein'] as const)(
    '%s: hostile prompt does not perturb graph topology, lands as a leaf',
    (engine) => {
      const build =
        engine === 'flux2-klein'
          ? buildFlux2SeamlessGraph
          : engine === 'qwen-image'
          ? buildQwenSeamlessGraph
          : buildZimageSeamlessGraph;
      const benign = build(params('a lake', 7, engine));
      const hostile = build(params(MALICIOUS, 7, engine));
      // The positive-prompt CLIPTextEncode node differs by engine (flux2 wires
      // positive at node 4, the KSampler-shaped engines at node 5).
      const positive = engine === 'flux2-klein' ? '4' : '5';

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
  const build = (p: SeamlessPanoParams): CustomComfyStepInput => seamlessPano360Recipe.buildStep(p, {});

  it('defaults to zimage-turbo when engine is omitted', () => {
    const step = build(params('a lake', 1));
    expect(step.trace).toBe('binary');
    expect(step.resources).toEqual([ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR, ZIMAGE_LORA_AIR]);
    expect(step.workflow['1'].class_type).toBe('UNETLoader');
  });

  it('qwen-image: the four Qwen AIRs + GGUF loader', () => {
    const step = build(params('a lake', 1, 'qwen-image'));
    expect(step.resources).toEqual([QWEN_DIFFUSION_AIR, QWEN_CLIP_AIR, QWEN_VAE_AIR, QWEN_LORA_AIR]);
    expect(step.workflow['1'].class_type).toBe('GGUFLoaderKJ');
  });

  it('flux2-klein: the four Klein AIRs + fleet sampler stack', () => {
    const step = build(params('a lake', 1, 'flux2-klein'));
    expect(step.resources).toEqual([FLUX2_DIFFUSION_AIR, FLUX2_CLIP_AIR, FLUX2_VAE_AIR, FLUX2_LORA_AIR]);
    expect(step.workflow['9'].class_type).toBe('CFGGuider');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Param schema — bounded + strict, no checkpoint (pinned policy).
// ─────────────────────────────────────────────────────────────────────────────
describe('seamlessPanoParamSchema', () => {
  it('accepts the bounded shape', () => {
    const r = seamlessPanoParamSchema.safeParse({ prompt: 'x', seed: 5, engine: 'qwen-image', accountType: 'blue' });
    expect(r.success).toBe(true);
  });
  it('rejects a prompt over the cap', () => {
    expect(seamlessPanoParamSchema.safeParse({ prompt: 'x'.repeat(PROMPT_MAX + 1) }).success).toBe(false);
  });
  it('rejects an unknown engine', () => {
    expect(seamlessPanoParamSchema.safeParse({ prompt: 'x', engine: 'sdxl' }).success).toBe(false);
  });
  it('rejects a checkpoint field (v1 pinned policy — .strict())', () => {
    expect(seamlessPanoParamSchema.safeParse({ prompt: 'x', checkpoint: { modelId: 1, versionId: 2 } }).success).toBe(
      false
    );
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

  it('declares the post-paid ceiling contract: maxBuzz == ceil(stepTimeoutSeconds)', () => {
    expect(seamlessPano360Recipe.stepTimeoutSeconds).toBe(180);
    expect(seamlessPano360Recipe.maxBuzz).toBe(Math.ceil(seamlessPano360Recipe.stepTimeoutSeconds));
  });

  it('is pinned (no user checkpoint) and pins the three 360Redmond LoRA versions', () => {
    expect(seamlessPano360Recipe.checkpointPolicy).toBe('pinned');
    expect(seamlessPano360Recipe.resourceAllowlist.checkpoints).toBeUndefined();
    expect(recipeCivitaiVersionIds(seamlessPano360Recipe).sort()).toEqual(
      [ZIMAGE_LORA_VERSION_ID, QWEN_LORA_VERSION_ID, FLUX2_LORA_VERSION_ID].sort()
    );
  });

  it('surfaces per-engine display estimates', () => {
    expect(seamlessPano360Recipe.estimateBuzz(params('x'))).toBe(ESTIMATE_BUZZ_BY_ENGINE['zimage-turbo']);
    expect(seamlessPano360Recipe.estimateBuzz(params('x', undefined, 'qwen-image'))).toBe(150);
    expect(seamlessPano360Recipe.estimateBuzz(params('x', undefined, 'flux2-klein'))).toBe(45);
  });
});
