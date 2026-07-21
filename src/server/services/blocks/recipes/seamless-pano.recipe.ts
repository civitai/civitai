import * as z from 'zod';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { BlockRecipe, ComfyGraph, CustomComfyStepInput } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// seamless-pano-360 — recipe #1 for the App Blocks `customComfy` bridge.
//
// Ported VERBATIM (by object construction) from the reference DEV app's
// `panorama.ts` graph builders (Koen's civitai-app-model-benchmarking). This is
// the server-authored, code-reviewed ComfyUI recipe — NEVER runtime/DB-editable.
// The iframe never sends a graph; it sends `{ recipe:'seamless-pano-360', params }`
// and the server owns the graph in full.
//
// v1 scope = the DiT engines only (Z-Image Turbo / Flux2 Klein / Qwen Image),
// each ONE `$type:'customComfy'` step with all stock/baked nodes — no nodepack
// snapshot, no layer-AIR cache. The SDXL conv-wrap engine (the nodepack-snapshot
// path) is deferred (plan R4).
//
// INERT/DARK: nothing in this module is wired into the live blocks.router submit
// / estimate path yet. PR6 (router + post-paid budget belt) is what calls it.
// ─────────────────────────────────────────────────────────────────────────────

/** The DiT engine variants this recipe exposes (v1 = DiT only, no SDXL). */
export const SEAMLESS_PANO_ENGINES = ['zimage-turbo', 'flux2-klein', 'qwen-image'] as const;
export type SeamlessPanoEngine = (typeof SEAMLESS_PANO_ENGINES)[number];

/** v1 default engine — cheapest/fastest (Z-Image Turbo, ~20 Buzz display estimate). */
export const DEFAULT_ENGINE: SeamlessPanoEngine = 'zimage-turbo';

// ── Prompt shaping ───────────────────────────────────────────────────────────
// The block schema already caps prompt at 1500; we re-clamp here so the ported
// builders stay byte-identical to the reference oracle for any input.
export const PROMPT_MAX = 1500;
export const PROMPT_SUFFIX = ', ultra detailed, masterpiece, best quality';
export const NEGATIVE_PROMPT =
  'ugly, blurry, low quality, watermark, jpeg artifacts, deformed, text, border, frame';

export function clampPrompt(raw: string): string {
  return raw.trim().slice(0, PROMPT_MAX);
}

/**
 * Each DiT LoRA variant publishes differently-cased/ordered trigger words. The
 * trigger-word prefix + quality suffix are appended AFTER the raw prompt is read
 * — the prompt-audit (PR6) reads `params.prompt` (the raw leaf), never this
 * decorated string, and the prompt is ALWAYS a leaf string value in the graph
 * (object construction), so it can never perturb graph topology (plan §7-3).
 */
export function ditPositivePrompt(triggerWords: string, scene: string): string {
  return triggerWords + clampPrompt(scene) + PROMPT_SUFFIX;
}

// ── Recipe-pinned civitai LoRA (360Redmond, per-engine DiT variants) ─────────
// All three are versions of the SAME public model (118025); pinned by the
// registry, entitlement-checked by PR6 against `resolveCanGenerateForVersions`.
export const LORA_MODEL_ID = 118025;

// ── Z-Image Turbo — model set mirrors the spine workers' own Z-Image builders ─
export const ZIMAGE_DIFFUSION_AIR =
  'urn:air:zimageturbo:diffusion_model:huggingface:Comfy-Org/z_image_turbo@main/split_files/diffusion_models/z_image_turbo_bf16.safetensors';
export const ZIMAGE_CLIP_AIR =
  'urn:air:qwen:clip:huggingface:Comfy-Org/z_image_turbo@main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors';
export const ZIMAGE_VAE_AIR =
  'urn:air:flux1:vae:huggingface:black-forest-labs/FLUX.1-dev@main/ae.safetensors';
// Ecosystem must be `zimageturbo` (the version's canonical AIR per the civitai
// API) — `zimage:lora` fails resource resolution on the workers.
export const ZIMAGE_LORA_VERSION_ID = 2702227;
export const ZIMAGE_LORA_AIR = `urn:air:zimageturbo:lora:civitai:${LORA_MODEL_ID}@${ZIMAGE_LORA_VERSION_ID}`;
export const ZIMAGE_LORA_STRENGTH = 1.0;
export const ZIMAGE_TRIGGER_WORDS = '360 view, 360, ';

export const ZIMAGE_SHIFT = 3.0;
export const ZIMAGE_STEPS = 8;
export const ZIMAGE_CFG = 1;
export const ZIMAGE_SAMPLER = 'euler';
export const ZIMAGE_SCHEDULER = 'simple';

// ── Qwen Image — the prod-warm 2512 GGUF (sage attention corrupts it) ────────
export const QWEN_DIFFUSION_AIR =
  'urn:air:qwen:diffusion_model:huggingface:unsloth/Qwen-Image-2512-GGUF@main/qwen-image-2512-Q5_K_M.gguf';
export const QWEN_CLIP_AIR =
  'urn:air:qwen:clip:huggingface:Comfy-Org/Qwen-Image_ComfyUI@main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors';
export const QWEN_VAE_AIR =
  'urn:air:qwen:vae:huggingface:Comfy-Org/Qwen-Image_ComfyUI@main/split_files/vae/qwen_image_vae.safetensors';
export const QWEN_LORA_VERSION_ID = 2702222;
export const QWEN_LORA_AIR = `urn:air:qwen:lora:civitai:${LORA_MODEL_ID}@${QWEN_LORA_VERSION_ID}`;
export const QWEN_LORA_STRENGTH = 1.0;
export const QWEN_TRIGGER_WORDS = '360 VIEW, 360, ';

export const QWEN_STEPS = 20;
export const QWEN_CFG = 2.5;
export const QWEN_SHIFT = 3.1;

// ── Flux2 Klein 9B — prod's ComfyUI variant ("9b-kv") ────────────────────────
export const FLUX2_DIFFUSION_AIR =
  'urn:air:flux2:diffusion_model:huggingface:black-forest-labs/FLUX.2-klein-9b-kv-fp8@main/flux-2-klein-9b-kv-fp8.safetensors';
export const FLUX2_CLIP_AIR =
  'urn:air:flux2:text_encoders:huggingface:Comfy-Org/vae-text-encorder-for-flux-klein-9b@main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors';
export const FLUX2_VAE_AIR =
  'urn:air:flux2:vae:huggingface:Comfy-Org/vae-text-encorder-for-flux-klein-9b@main/split_files/vae/flux2-vae.safetensors';
export const FLUX2_LORA_VERSION_ID = 2702214;
export const FLUX2_LORA_AIR = `urn:air:flux2:lora:civitai:${LORA_MODEL_ID}@${FLUX2_LORA_VERSION_ID}`;
export const FLUX2_LORA_STRENGTH = 1.0;
export const FLUX2_TRIGGER_WORDS = '360 View, 360, ';

// Klein is step-distilled but NOT guidance-distilled — cfg 5 is real guidance,
// so the negative prompt is active.
export const FLUX2_STEPS = 8;
export const FLUX2_CFG = 5;

// ── Canvas + seam-heal tunables ──────────────────────────────────────────────
// 2:1 equirectangular. 2048 is also the block bridge's DIM_MAX.
export const PANO_WIDTH = 2048;
export const PANO_HEIGHT = 1024;
const HALF_W = PANO_WIDTH / 2;

// Seam-heal tunables. Denoise below 0.7 leaves the seam line partially intact;
// the wide feather blends the repaint in.
export const SEAM_BAND_PX = 320;
export const SEAM_FEATHER_PX = 128;
export const SEAM_DENOISE = 0.7;
export const SEAM_STEPS = 8;

/** Per-engine display estimate (post-paid has no exact pre-price — display only). */
export const ESTIMATE_BUZZ_BY_ENGINE: Record<SeamlessPanoEngine, number> = {
  'zimage-turbo': 20,
  'flux2-klein': 45,
  'qwen-image': 150,
};

// ── Per-engine POST-PAID BUDGET (v1.1) ───────────────────────────────────────
// The hard per-job Buzz ceiling, sized PER ENGINE. `maxBuzz` MUST equal
// `ceil(stepTimeoutSeconds × 1)` for EACH entry (asserted at registry load) —
// the step `timeout` is the PHYSICAL cap (~1 Buzz/GPU-second), so a lower
// reservation without a matching lower timeout would let the job run past what
// was reserved and under-count spend. The router reserves `maxBuzz` against every
// cap and settles-to-actual, so a cheaper engine reserves (and settles) less cap.
//
// The three timeout numbers are the ONE reviewer judgment call here (a `timeout`
// is a HARD kill on a slow gen, so headroom over typical runtime matters):
//   • qwen-image  180s — UNCHANGED from the single-ceiling v1 (zero regression on
//                        the priciest engine; ~150 Buzz display estimate).
//   • zimage-turbo 90s — ≈ 4× the 21-Buzz dogfood-measured actual.
//   • flux2-klein 150s — ≈ 3.3× its 45-Buzz DISPLAY ESTIMATE. flux2's runtime is
//                        characterized only by that estimate (no dogfood-measured
//                        actual like zimage's 21), so 150 gives more margin against
//                        a hard-kill of a legit gen than 120 did, while still
//                        cutting over-reservation from the flat 180.
// All tunable in this one obvious table. The MAX entry (180) still holds the
// app-manifest invariant `page.buzzBudgetPerGen (200) ≥ recipe ceiling`.
export const BUDGET_BY_ENGINE: Record<
  SeamlessPanoEngine,
  { stepTimeoutSeconds: number; maxBuzz: number }
> = {
  'zimage-turbo': { stepTimeoutSeconds: 90, maxBuzz: 90 },
  'flux2-klein': { stepTimeoutSeconds: 150, maxBuzz: 150 },
  'qwen-image': { stepTimeoutSeconds: 180, maxBuzz: 180 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Param schema — .strict(), no checkpoint (v1 pinned policy).
// Mirrors the reference PanoBody minus the user-picked SDXL checkpoint.
// Account-type enum is built from the SAME source of truth (buzzSpendTypes) the
// block schema's `blockAccountTypeSchema` uses — imported directly (not from
// workflow.schema) to avoid a workflow.schema ⇄ recipes import cycle.
// ─────────────────────────────────────────────────────────────────────────────
export const seamlessPanoParamSchema = z
  .object({
    prompt: z.string().max(PROMPT_MAX),
    seed: z.coerce.number().int().nullish(),
    engine: z.enum(SEAMLESS_PANO_ENGINES).optional(),
    accountType: z
      .enum(buzzSpendTypes as [BuzzSpendType, ...BuzzSpendType[]])
      .optional(),
  })
  .strict();

export type SeamlessPanoParams = z.infer<typeof seamlessPanoParamSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Graph builders — ported verbatim from panorama.ts (object construction only).
// The prompt is always a leaf string value; there is NO string-templating of the
// graph structure (injection-safe by construction).
// ─────────────────────────────────────────────────────────────────────────────

function resolveSeed(seed: number | null | undefined): number {
  return seed ?? Math.floor(Math.random() * 2_147_483_647);
}

/** Everything that differs between the KSampler-shaped DiT engines. */
export interface DitEngineSpec {
  diffusionAir: string;
  /** The whole diffusion-loader node — engines differ in loader class too. */
  loader: { class_type: string; inputs: Record<string, unknown> };
  clipAir: string;
  clipType: string;
  vaeAir: string;
  loraAir: string;
  loraStrength: number;
  triggerWords: string;
  shift: number;
  steps: number;
  cfg: number;
  /** '' when cfg is 1 (guidance off — the encode is wired but inert). */
  negativePrompt: string;
}

export const ZIMAGE_SPEC: DitEngineSpec = {
  diffusionAir: ZIMAGE_DIFFUSION_AIR,
  loader: {
    class_type: 'UNETLoader',
    inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
  },
  clipAir: ZIMAGE_CLIP_AIR,
  clipType: 'lumina2',
  vaeAir: ZIMAGE_VAE_AIR,
  loraAir: ZIMAGE_LORA_AIR,
  loraStrength: ZIMAGE_LORA_STRENGTH,
  triggerWords: ZIMAGE_TRIGGER_WORDS,
  shift: ZIMAGE_SHIFT,
  steps: ZIMAGE_STEPS,
  cfg: ZIMAGE_CFG,
  negativePrompt: '',
};

export const QWEN_SPEC: DitEngineSpec = {
  diffusionAir: QWEN_DIFFUSION_AIR,
  // The fleet launches ComfyUI with --use-sage-attention, which silently
  // corrupts the attention mask Qwen passes — GGUFLoaderKJ's `sdpa` override
  // forces pytorch attention.
  loader: {
    class_type: 'GGUFLoaderKJ',
    inputs: {
      model_name: QWEN_DIFFUSION_AIR,
      extra_model_name: 'none',
      dequant_dtype: 'default',
      patch_dtype: 'default',
      patch_on_device: false,
      enable_fp16_accumulation: false,
      attention_override: 'sdpa',
    },
  },
  clipAir: QWEN_CLIP_AIR,
  clipType: 'qwen_image',
  vaeAir: QWEN_VAE_AIR,
  loraAir: QWEN_LORA_AIR,
  loraStrength: QWEN_LORA_STRENGTH,
  triggerWords: QWEN_TRIGGER_WORDS,
  shift: QWEN_SHIFT,
  steps: QWEN_STEPS,
  cfg: QWEN_CFG,
  negativePrompt: NEGATIVE_PROMPT,
};

/**
 * 50% horizontal roll: id: left crop, id+1: right crop, id+2: [R|L] stitch.
 * ComfyUI has no roll node; crop+stitch is an involution, so applying it again
 * rolls back.
 */
function rollNodes(id: number, image: [string, number]): ComfyGraph {
  return {
    [`${id}`]: {
      class_type: 'ImageCrop',
      inputs: { image, width: HALF_W, height: PANO_HEIGHT, x: 0, y: 0 },
    },
    [`${id + 1}`]: {
      class_type: 'ImageCrop',
      inputs: { image, width: HALF_W, height: PANO_HEIGHT, x: HALF_W, y: 0 },
    },
    [`${id + 2}`]: {
      class_type: 'ImageStitch',
      inputs: {
        image1: [`${id + 1}`, 0],
        image2: [`${id}`, 0],
        direction: 'right',
        match_image_size: true,
        spacing_width: 0,
        spacing_color: 'white',
      },
    },
  };
}

/** Feathered band mask over the centered seam: ids id..id+3, output at id+3. */
function bandMaskNodes(id: number): ComfyGraph {
  return {
    [`${id}`]: {
      class_type: 'SolidMask',
      inputs: { value: 0, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    [`${id + 1}`]: {
      class_type: 'SolidMask',
      inputs: { value: 1, width: SEAM_BAND_PX, height: PANO_HEIGHT },
    },
    [`${id + 2}`]: {
      class_type: 'MaskComposite',
      inputs: {
        destination: [`${id}`, 0],
        source: [`${id + 1}`, 0],
        x: (PANO_WIDTH - SEAM_BAND_PX) / 2,
        y: 0,
        operation: 'add',
      },
    },
    [`${id + 3}`]: {
      class_type: 'FeatherMask',
      inputs: {
        mask: [`${id + 2}`, 0],
        left: SEAM_FEATHER_PX,
        top: 0,
        right: SEAM_FEATHER_PX,
        bottom: 0,
      },
    },
  };
}

/** Z-Image + Qwen share one KSampler-shaped graph (loader aside). */
export function buildDitSeamlessGraph(spec: DitEngineSpec, params: SeamlessPanoParams): ComfyGraph {
  const seed = resolveSeed(params.seed);

  return {
    '1': spec.loader,
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: spec.loraAir, strength_model: spec.loraStrength },
    },
    '3': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['2', 0], shift: spec.shift },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: spec.clipAir, type: spec.clipType, device: 'default' },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: ditPositivePrompt(spec.triggerWords, params.prompt) },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: spec.negativePrompt },
    },
    '7': {
      class_type: 'VAELoader',
      inputs: { vae_name: spec.vaeAir },
    },
    '8': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: PANO_WIDTH, height: PANO_HEIGHT, batch_size: 1 },
    },
    '9': {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['8', 0],
        seed,
        steps: spec.steps,
        cfg: spec.cfg,
        sampler_name: ZIMAGE_SAMPLER,
        scheduler: ZIMAGE_SCHEDULER,
        denoise: 1.0,
      },
    },
    '10': {
      class_type: 'VAEDecode',
      inputs: { samples: ['9', 0], vae: ['7', 0] },
    },
    ...rollNodes(11, ['10', 0]),
    ...bandMaskNodes(14),
    '18': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['13', 0], vae: ['7', 0] },
    },
    '19': {
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['18', 0], mask: ['17', 0] },
    },
    '20': {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['19', 0],
        seed: seed + 1,
        steps: SEAM_STEPS,
        cfg: spec.cfg,
        sampler_name: ZIMAGE_SAMPLER,
        scheduler: ZIMAGE_SCHEDULER,
        denoise: SEAM_DENOISE,
      },
    },
    '21': {
      class_type: 'VAEDecode',
      inputs: { samples: ['20', 0], vae: ['7', 0] },
    },
    ...rollNodes(22, ['21', 0]),
    '25': {
      class_type: 'SaveImage',
      inputs: { images: ['24', 0], filename_prefix: 'panorama' },
    },
  };
}

export function buildZimageSeamlessGraph(params: SeamlessPanoParams): ComfyGraph {
  return buildDitSeamlessGraph(ZIMAGE_SPEC, params);
}

export function buildQwenSeamlessGraph(params: SeamlessPanoParams): ComfyGraph {
  return buildDitSeamlessGraph(QWEN_SPEC, params);
}

/**
 * Klein via the fleet's sampler stack. The seam pass gets its partial denoise
 * from SplitSigmasDenoise's low_sigmas (output 1): SamplerCustomAdvanced scales
 * its noise to the first sigma given, exactly like KSampler denoise<1.
 */
export function buildFlux2SeamlessGraph(params: SeamlessPanoParams): ComfyGraph {
  const seed = resolveSeed(params.seed);

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: FLUX2_DIFFUSION_AIR, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: FLUX2_LORA_AIR, strength_model: FLUX2_LORA_STRENGTH },
    },
    '3': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: FLUX2_CLIP_AIR, type: 'flux2', device: 'default' },
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: ditPositivePrompt(FLUX2_TRIGGER_WORDS, params.prompt) },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: NEGATIVE_PROMPT },
    },
    '6': {
      class_type: 'VAELoader',
      inputs: { vae_name: FLUX2_VAE_AIR },
    },
    '7': {
      class_type: 'EmptyFlux2LatentImage',
      inputs: { width: PANO_WIDTH, height: PANO_HEIGHT, batch_size: 1 },
    },
    '8': {
      class_type: 'Flux2Scheduler',
      inputs: { steps: FLUX2_STEPS, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    '9': {
      class_type: 'CFGGuider',
      inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], cfg: FLUX2_CFG },
    },
    '10': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: seed },
    },
    '11': {
      class_type: 'KSamplerSelect',
      inputs: { sampler_name: ZIMAGE_SAMPLER },
    },
    '12': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['10', 0],
        guider: ['9', 0],
        sampler: ['11', 0],
        sigmas: ['8', 0],
        latent_image: ['7', 0],
      },
    },
    '13': {
      class_type: 'VAEDecode',
      inputs: { samples: ['12', 0], vae: ['6', 0] },
    },
    ...rollNodes(14, ['13', 0]),
    ...bandMaskNodes(17),
    '21': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['16', 0], vae: ['6', 0] },
    },
    '22': {
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['21', 0], mask: ['20', 0] },
    },
    '23': {
      class_type: 'Flux2Scheduler',
      inputs: { steps: SEAM_STEPS, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    '24': {
      class_type: 'SplitSigmasDenoise',
      inputs: { sigmas: ['23', 0], denoise: SEAM_DENOISE },
    },
    '25': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: seed + 1 },
    },
    '26': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['25', 0],
        guider: ['9', 0],
        sampler: ['11', 0],
        sigmas: ['24', 1],
        latent_image: ['22', 0],
      },
    },
    '27': {
      class_type: 'VAEDecode',
      inputs: { samples: ['26', 0], vae: ['6', 0] },
    },
    ...rollNodes(28, ['27', 0]),
    '31': {
      class_type: 'SaveImage',
      inputs: { images: ['30', 0], filename_prefix: 'panorama' },
    },
  };
}

/**
 * The reusable graph-construction step. Selects the engine's resource AIRs +
 * ComfyUI graph and returns the `customComfy` step INPUT (`{ resources, trace,
 * workflow }`). Deliberately separable from the `$type:'customComfy'` step
 * wrapper (`createBlockCustomComfyStep`) so ONLY the wrapper — not this graph —
 * changes if a future prepaid path registers it as a `$type:'comfy'` definition.
 */
function buildStep(params: SeamlessPanoParams): CustomComfyStepInput {
  const engine = params.engine ?? DEFAULT_ENGINE;
  const [resources, workflow] =
    engine === 'flux2-klein'
      ? ([[FLUX2_DIFFUSION_AIR, FLUX2_CLIP_AIR, FLUX2_VAE_AIR, FLUX2_LORA_AIR], buildFlux2SeamlessGraph(params)] as const)
      : engine === 'qwen-image'
      ? ([[QWEN_DIFFUSION_AIR, QWEN_CLIP_AIR, QWEN_VAE_AIR, QWEN_LORA_AIR], buildQwenSeamlessGraph(params)] as const)
      : ([[ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR, ZIMAGE_LORA_AIR], buildZimageSeamlessGraph(params)] as const);
  return { resources: [...resources], trace: 'binary', workflow };
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipe definition.
// ─────────────────────────────────────────────────────────────────────────────
export const seamlessPano360Recipe: BlockRecipe<SeamlessPanoParams> = {
  id: 'seamless-pano-360',
  paramSchema: seamlessPanoParamSchema,
  engines: SEAMLESS_PANO_ENGINES,
  buildStep,
  resourceAllowlist: {
    // No civitai checkpoint (DiT engines have no UNet checkpoint; pinned policy).
    // The per-engine 360Redmond LoRA versions ARE gated civitai versions — PR6
    // runs `resolveCanGenerateForVersions` over these before submit.
    loras: [
      { modelId: LORA_MODEL_ID, modelVersionId: ZIMAGE_LORA_VERSION_ID },
      { modelId: LORA_MODEL_ID, modelVersionId: QWEN_LORA_VERSION_ID },
      { modelId: LORA_MODEL_ID, modelVersionId: FLUX2_LORA_VERSION_ID },
    ],
    // The diffusion/clip/vae AIRs are huggingface AIRs (not gated civitai
    // versions) — recipe constants, exempt-by-construction (code-reviewed).
    staticAirs: [
      ZIMAGE_DIFFUSION_AIR,
      ZIMAGE_CLIP_AIR,
      ZIMAGE_VAE_AIR,
      QWEN_DIFFUSION_AIR,
      QWEN_CLIP_AIR,
      QWEN_VAE_AIR,
      FLUX2_DIFFUSION_AIR,
      FLUX2_CLIP_AIR,
      FLUX2_VAE_AIR,
    ],
  },
  checkpointPolicy: 'pinned',
  // THE post-paid budget contract (plan §5), now PER ENGINE (v1.1): `maxBuzz` MUST
  // equal ceil(stepTimeoutSeconds × 1) for the resolved engine. A DiT panorama
  // renders in well under a minute; each timeout is a deliberately tight
  // blast-radius ceiling (vs the reference's loose 3600s). The step `timeout`
  // physically caps the job at `maxBuzz` Buzz. See BUDGET_BY_ENGINE above.
  budgetForEngine: (engine) =>
    BUDGET_BY_ENGINE[engine as SeamlessPanoEngine] ?? BUDGET_BY_ENGINE[DEFAULT_ENGINE],
  budgetFor: (params) =>
    BUDGET_BY_ENGINE[params.engine ?? DEFAULT_ENGINE] ?? BUDGET_BY_ENGINE[DEFAULT_ENGINE],
  estimateBuzz: (params) => ESTIMATE_BUZZ_BY_ENGINE[params.engine ?? DEFAULT_ENGINE],
  negativePrompt: NEGATIVE_PROMPT,
};
