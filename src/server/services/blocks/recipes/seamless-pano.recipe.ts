import * as z from 'zod';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { BlockRecipe, ComfyGraph, CustomComfyStepInput } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// seamless-pano-360 — recipe #1 for the App Blocks `customComfy` bridge.
//
// Ported from the reference DEV app's `panorama.ts` graph builders (Z-Image Turbo
// engine only). This is the server-authored, code-reviewed ComfyUI recipe —
// NEVER runtime/DB-editable.
// The iframe never sends a graph; it sends `{ recipe:'seamless-pano-360', params }`
// and the server owns the graph in full.
//
// One DiT engine, Z-Image Turbo, as ONE `customComfy` step of stock/baked nodes —
// no nodepack snapshot, no layer-AIR cache. Its weights are Civitai versions
// (`app-step-resources`).
//
// LIVE: registered in `recipes/index.ts`, which the blocks.router customComfy submit resolves.
// ─────────────────────────────────────────────────────────────────────────────

/** The engine variants this recipe exposes. */
export const SEAMLESS_PANO_ENGINES = ['zimage-turbo'] as const;
export type SeamlessPanoEngine = (typeof SEAMLESS_PANO_ENGINES)[number];

/** v1 default engine — cheapest/fastest (Z-Image Turbo, ~20 Buzz display estimate). */
export const DEFAULT_ENGINE: SeamlessPanoEngine = 'zimage-turbo';

/**
 * The SINGLE resolution of "which engine did this submit pick" — `params.engine`
 * or the recipe default. Every per-engine derivation (budget ceiling, built
 * graph, display estimate, settle-time metric label) funnels through this so the
 * CHARGED ceiling and the OBSERVED label can never drift. Returns a bounded
 * `SeamlessPanoEngine` (params.engine is enum-validated by the schema).
 */
export function resolveEngine(params: SeamlessPanoParams): SeamlessPanoEngine {
  return params.engine ?? DEFAULT_ENGINE;
}

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

// ── Recipe-pinned civitai LoRA (360Redmond) ─────────────────────────────────
// Pinned by the registry, entitlement-checked by the router.
export const LORA_MODEL_ID = 118025;

// ── Z-Image Turbo ──────────────────────────────────────────────────────────
// Official Civitai copies, byte-identical (SHA-256) to the Comfy-Org files the
// reference used. `+<fileId>` picks the file on a version that holds several.
export const ZIMAGE_DIFFUSION_AIR =
  'urn:air:zimageturbo:diffusion_model:civitai:2168935@2442439+2333412';
// The fp8 text encoder ships on Z Image Base, not on the Turbo version.
export const ZIMAGE_CLIP_AIR = 'urn:air:zimagebase:clip:civitai:2342797@2635223+2523804';
export const ZIMAGE_VAE_AIR = 'urn:air:zimageturbo:vae:civitai:2168935@2442439+2333440';
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
};

// ── Per-engine POST-PAID BUDGET (v1.1) ───────────────────────────────────────
// The hard per-job Buzz ceiling, sized PER ENGINE. `maxBuzz` MUST equal
// `ceil(stepTimeoutSeconds × 1)` for EACH entry (asserted at registry load) —
// the step `timeout` is the PHYSICAL cap (~1 Buzz/GPU-second), so a lower
// reservation without a matching lower timeout would let the job run past what
// was reserved and under-count spend. The router reserves `maxBuzz` against every
// cap and settles-to-actual, so a cheaper engine reserves (and settles) less cap.
//
// The timeout is the one reviewer judgment call here (a `timeout` is a HARD
// kill on a slow gen, so headroom over typical runtime matters): 90s is ≈ 4× the
// 21-Buzz dogfood-measured actual. It holds the app-manifest invariant
// `page.buzzBudgetPerGen ≥ recipe ceiling`.
export const BUDGET_BY_ENGINE: Record<
  SeamlessPanoEngine,
  { stepTimeoutSeconds: number; maxBuzz: number }
> = {
  'zimage-turbo': { stepTimeoutSeconds: 90, maxBuzz: 90 },
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
    accountType: z.enum(buzzSpendTypes as [BuzzSpendType, ...BuzzSpendType[]]).optional(),
  })
  .strict();

export type SeamlessPanoParams = z.infer<typeof seamlessPanoParamSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Graph builder — ported from panorama.ts (object construction only).
// The prompt is always a leaf string value; there is NO string-templating of the
// graph structure (injection-safe by construction).
// ─────────────────────────────────────────────────────────────────────────────

function resolveSeed(seed: number | null | undefined): number {
  return seed ?? Math.floor(Math.random() * 2_147_483_647);
}

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

/** The KSampler-shaped Z-Image graph: generate, roll the seam to the centre, heal it, roll back. */
export function buildZimageSeamlessGraph(params: SeamlessPanoParams): ComfyGraph {
  const seed = resolveSeed(params.seed);

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: ZIMAGE_LORA_AIR, strength_model: ZIMAGE_LORA_STRENGTH },
    },
    '3': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['2', 0], shift: ZIMAGE_SHIFT },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: ZIMAGE_CLIP_AIR, type: 'lumina2', device: 'default' },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: ditPositivePrompt(ZIMAGE_TRIGGER_WORDS, params.prompt) },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      // cfg 1 turns guidance off, so the negative encode is wired but inert.
      inputs: { clip: ['4', 0], text: '' },
    },
    '7': {
      class_type: 'VAELoader',
      inputs: { vae_name: ZIMAGE_VAE_AIR },
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
        steps: ZIMAGE_STEPS,
        cfg: ZIMAGE_CFG,
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
        cfg: ZIMAGE_CFG,
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

/**
 * The reusable graph-construction step. Selects the engine's resource AIRs +
 * ComfyUI graph and returns the `customComfy` step INPUT (`{ resources, trace,
 * workflow }`). Deliberately separable from the `$type:'customComfy'` step
 * wrapper (`createBlockCustomComfyStep`) so ONLY the wrapper — not this graph —
 * changes if a future prepaid path registers it as a `$type:'comfy'` definition.
 */
function buildStep(params: SeamlessPanoParams): CustomComfyStepInput {
  return {
    resources: [ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR, ZIMAGE_LORA_AIR],
    trace: 'binary',
    workflow: buildZimageSeamlessGraph(params),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipe definition.
// ─────────────────────────────────────────────────────────────────────────────
export const seamlessPano360Recipe: BlockRecipe<SeamlessPanoParams> = {
  id: 'seamless-pano-360',
  paramSchema: seamlessPanoParamSchema,
  engines: SEAMLESS_PANO_ENGINES,
  resolveEngine,
  buildStep,
  resourceAllowlist: {
    // No checkpoint: a DiT engine loads a diffusion model, not a UNet checkpoint.
    // The 360Redmond LoRA version IS a gated civitai version — the router runs
    // `resolveCanGenerateForVersions` over it before submit.
    loras: [{ modelId: LORA_MODEL_ID, modelVersionId: ZIMAGE_LORA_VERSION_ID }],
    staticAirs: [ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR],
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
    BUDGET_BY_ENGINE[resolveEngine(params)] ?? BUDGET_BY_ENGINE[DEFAULT_ENGINE],
  estimateBuzz: (params) => ESTIMATE_BUZZ_BY_ENGINE[resolveEngine(params)],
  negativePrompt: NEGATIVE_PROMPT,
};
