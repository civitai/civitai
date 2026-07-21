import { describe, expect, it } from 'vitest';

import {
  STARTER_BUDGET,
  STARTER_CFG,
  STARTER_COMFY_ENGINES,
  STARTER_ESTIMATE_BUZZ,
  STARTER_HEIGHT,
  STARTER_SHIFT,
  STARTER_STEPS,
  STARTER_WIDTH,
  buildStarterTxt2imgGraph,
  starterComfyParamSchema,
  starterComfyTxt2imgRecipe,
  type StarterComfyParams,
} from '../starter-comfy-txt2img.recipe';
import {
  NEGATIVE_PROMPT,
  PROMPT_MAX,
  ZIMAGE_CLIP_AIR,
  ZIMAGE_DIFFUSION_AIR,
  ZIMAGE_VAE_AIR,
} from '../seamless-pano.recipe';
import {
  REGISTERED_RECIPE_IDS,
  getRecipe,
  recipeCivitaiVersionIds,
  type ComfyGraph,
  type CustomComfyStepInput,
} from '../index';

const params = (prompt: string, seed?: number): StarterComfyParams => ({
  prompt,
  ...(seed !== undefined ? { seed } : {}),
});

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN-GRAPH — the minimal single-step Z-Image txt2img topology. A builder that
// drifts (wrong link ref, class_type, or widget) fails here.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildStarterTxt2imgGraph (golden: minimal Z-Image txt2img)', () => {
  const graph = buildStarterTxt2imgGraph(params('an icy lake', 42));

  it('loads the Z-Image split model set: UNET, aura-flow shift, lumina2 clip, vae', () => {
    expect(graph['1']).toEqual({
      class_type: 'UNETLoader',
      inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
    });
    expect(graph['2']).toEqual({
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['1', 0], shift: STARTER_SHIFT },
    });
    expect(graph['3'].inputs).toMatchObject({ clip_name: ZIMAGE_CLIP_AIR, type: 'lumina2' });
    expect(graph['6'].inputs.vae_name).toBe(ZIMAGE_VAE_AIR);
  });

  it('has NO LoRA node — a plain single-step graph (no LoraLoaderModelOnly)', () => {
    const classes = Object.values(graph).map((n) => n.class_type);
    expect(classes).not.toContain('LoraLoaderModelOnly');
  });

  it('turbo sampling: 8 steps, cfg 1, euler/simple, single 1024×1024 latent', () => {
    expect(graph['7']).toEqual({
      class_type: 'EmptySD3LatentImage',
      inputs: { width: STARTER_WIDTH, height: STARTER_HEIGHT, batch_size: 1 },
    });
    expect(STARTER_WIDTH).toBe(1024);
    expect(STARTER_HEIGHT).toBe(1024);
    expect(graph['8'].inputs).toMatchObject({
      model: ['2', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['7', 0],
      seed: 42,
      steps: STARTER_STEPS,
      cfg: STARTER_CFG,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1.0,
    });
  });

  it('the prompt is a LEAF string on the positive CLIPTextEncode; negative is inert (cfg 1)', () => {
    expect(graph['4']).toEqual({
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: 'an icy lake' },
    });
    expect(graph['5'].inputs.text).toBe('');
  });

  it('decodes and saves — the terminal nodes wire straight through', () => {
    expect(graph['9']).toEqual({
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['6', 0] },
    });
    expect(graph['10']).toMatchObject({ class_type: 'SaveImage', inputs: { images: ['9', 0] } });
    // Exactly 10 nodes — the minimal graph, no seam-heal / roll nodes.
    expect(Object.keys(graph)).toHaveLength(10);
  });

  it('randomizes the seed when omitted', () => {
    const g = buildStarterTxt2imgGraph(params('a lake'));
    const seed = g['8'].inputs.seed as number;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection safety — a prompt with graph-hostile bytes yields a STRUCTURALLY
// identical graph (object construction; prompt is a leaf). Plan §7-3.
// ─────────────────────────────────────────────────────────────────────────────
describe('prompt injection safety', () => {
  const MALICIOUS = 'a lake", "class_type": "Evil"}, "999": {{ </script> \\   end';
  const structure = (g: ComfyGraph) =>
    Object.fromEntries(Object.entries(g).map(([id, n]) => [id, n.class_type]));

  it('hostile prompt does not perturb graph topology, lands as a leaf', () => {
    const benign = buildStarterTxt2imgGraph(params('a lake', 7));
    const hostile = buildStarterTxt2imgGraph(params(MALICIOUS, 7));
    expect(structure(hostile)).toEqual(structure(benign));
    expect(hostile['4'].inputs.text).toBe(MALICIOUS);
    // Survives a JSON round-trip as a single escaped string value — never structure.
    const revived = JSON.parse(JSON.stringify(hostile)) as ComfyGraph;
    expect(structure(revived)).toEqual(structure(benign));
    expect(revived['4'].inputs.text).toBe(MALICIOUS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildStep — resources + trace (no engine axis).
// ─────────────────────────────────────────────────────────────────────────────
describe('recipe.buildStep', () => {
  const build = (p: StarterComfyParams): CustomComfyStepInput =>
    starterComfyTxt2imgRecipe.buildStep(p, {});

  it('emits ONLY the three huggingface AIRs (no LoRA) + the binary trace', () => {
    const step = build(params('a lake', 1));
    expect(step.trace).toBe('binary');
    expect(step.resources).toEqual([ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR]);
    expect(step.workflow['1'].class_type).toBe('UNETLoader');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Param schema — bounded + strict, no engine, no checkpoint.
// ─────────────────────────────────────────────────────────────────────────────
describe('starterComfyParamSchema', () => {
  it('accepts the bounded shape', () => {
    expect(
      starterComfyParamSchema.safeParse({ prompt: 'x', seed: 5, accountType: 'blue' }).success
    ).toBe(true);
  });
  it('rejects a prompt over the cap', () => {
    expect(starterComfyParamSchema.safeParse({ prompt: 'x'.repeat(PROMPT_MAX + 1) }).success).toBe(
      false
    );
  });
  it('rejects an engine field (single fixed graph — .strict())', () => {
    expect(starterComfyParamSchema.safeParse({ prompt: 'x', engine: 'zimage-turbo' }).success).toBe(
      false
    );
  });
  it('rejects a checkpoint field (pinned policy — .strict())', () => {
    expect(
      starterComfyParamSchema.safeParse({ prompt: 'x', checkpoint: { modelId: 1, versionId: 2 } })
        .success
    ).toBe(false);
  });
  it('coerces a string seed and tolerates null', () => {
    expect(starterComfyParamSchema.parse({ prompt: 'x', seed: '9' }).seed).toBe(9);
    expect(starterComfyParamSchema.parse({ prompt: 'x', seed: null }).seed).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipe contract + registry wiring.
// ─────────────────────────────────────────────────────────────────────────────
describe('starterComfyTxt2imgRecipe contract', () => {
  it('is registered under its id and reachable via getRecipe', () => {
    expect(REGISTERED_RECIPE_IDS).toContain('starter-comfy-txt2img');
    expect(getRecipe('starter-comfy-txt2img')).toBe(starterComfyTxt2imgRecipe);
  });

  it('exposes a single nominal engine and resolves to it for any params', () => {
    expect(STARTER_COMFY_ENGINES).toEqual(['default']);
    expect(starterComfyTxt2imgRecipe.resolveEngine(params('x'))).toBe('default');
    expect(starterComfyTxt2imgRecipe.resolveEngine(params('y', 7))).toBe('default');
  });

  it('honors the post-paid ceiling contract: maxBuzz === ceil(stepTimeoutSeconds) === 30', () => {
    expect(STARTER_BUDGET).toEqual({ stepTimeoutSeconds: 30, maxBuzz: 30 });
    expect(STARTER_BUDGET.maxBuzz).toBe(Math.ceil(STARTER_BUDGET.stepTimeoutSeconds));
  });

  it('budgetFor / budgetForEngine both return the ceiling-30 budget', () => {
    expect(starterComfyTxt2imgRecipe.budgetFor(params('x'))).toEqual({
      maxBuzz: 30,
      stepTimeoutSeconds: 30,
    });
    expect(starterComfyTxt2imgRecipe.budgetForEngine('default')).toEqual({
      maxBuzz: 30,
      stepTimeoutSeconds: 30,
    });
  });

  it('pins NO civitai resources → recipeCivitaiVersionIds is empty (entitlement gate skipped)', () => {
    expect(starterComfyTxt2imgRecipe.checkpointPolicy).toBe('pinned');
    expect(starterComfyTxt2imgRecipe.resourceAllowlist.checkpoints).toBeUndefined();
    expect(starterComfyTxt2imgRecipe.resourceAllowlist.loras).toBeUndefined();
    expect(recipeCivitaiVersionIds(starterComfyTxt2imgRecipe)).toEqual([]);
  });

  it('surfaces the fixed display estimate and a sensible negative prompt', () => {
    expect(starterComfyTxt2imgRecipe.estimateBuzz(params('x'))).toBe(STARTER_ESTIMATE_BUZZ);
    expect(STARTER_ESTIMATE_BUZZ).toBe(15);
    expect(starterComfyTxt2imgRecipe.negativePrompt).toBe(NEGATIVE_PROMPT);
  });
});
