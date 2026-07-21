import * as z from 'zod';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { BlockRecipe, ComfyGraph, CustomComfyStepInput } from './index';
import {
  NEGATIVE_PROMPT,
  PROMPT_MAX,
  ZIMAGE_CLIP_AIR,
  ZIMAGE_DIFFUSION_AIR,
  ZIMAGE_VAE_AIR,
} from './seamless-pano.recipe';

// ─────────────────────────────────────────────────────────────────────────────
// starter-comfy-txt2img — recipe #2 for the App Blocks `customComfy` bridge.
//
// The DEMOABLE STARTER: the recipe the CLI scaffold's default `customComfy` sample
// invokes. Deliberately the CHEAPEST viable graph — a minimal single-step Z-Image
// (DiT) txt2img producing one 1024×1024 image — so a new app author sees the
// customComfy plumbing end-to-end (recipe id on the wire → server-authored graph →
// post-paid budget belt → orchestrator) with the least moving parts. Real recipes
// (seamless-pano-360, future ones) do things `kind:textToImage` cannot; this one
// exists to show the WIRING, not a sophisticated workflow.
//
// 🔴 NO civitai-pinned resources. It pins ONLY huggingface `staticAirs` (the same
// Z-Image diffusion/clip/vae AIRs seamless-pano reuses) — no `loras`, no
// `checkpoints`. So `recipeCivitaiVersionIds(recipe)` returns `[]` and the router's
// entitlement-gate loop (resolveCanGenerateForVersions over pinned versions) is
// skipped entirely: the simplest, safest starter, sidestepping the early-access /
// Private invariant (index.ts RESOURCE INVARIANT) by construction. `checkpointPolicy:
// 'pinned'` (no user-picked checkpoint).
//
// Like every recipe module here: server-authored, code-reviewed, NEVER
// runtime/DB-editable. The iframe sends `{ recipe:'starter-comfy-txt2img', params }`
// and the server owns the graph in full. The prompt is ALWAYS a leaf string value
// (object construction only — never string-templated into graph topology; the
// injection-safety invariant, plan §7-3).
//
// DARK: customComfy is behind the mod-gated app-blocks flag. Adding this recipe
// only widens the wire schema's `recipe` enum (derived from REGISTERED_RECIPE_IDS).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single nominal engine — this recipe has ONE fixed graph (no engine axis, unlike
 * seamless-pano's DiT variants), so `engines` is a single sentinel. Every
 * per-engine derivation (budget ceiling, built graph, display estimate, settle
 * label) funnels through `resolveEngine` → this value, per the #3273 pattern.
 */
export const STARTER_COMFY_ENGINES = ['default'] as const;
export type StarterComfyEngine = (typeof STARTER_COMFY_ENGINES)[number];
export const STARTER_COMFY_DEFAULT_ENGINE: StarterComfyEngine = 'default';

// ── Graph tunables (Z-Image Turbo, mirrors the spine workers' own builder) ────
// A plain 1024×1024 image — no panorama canvas, no LoRA, no seam-heal pass.
export const STARTER_WIDTH = 1024;
export const STARTER_HEIGHT = 1024;
export const STARTER_STEPS = 8;
export const STARTER_CFG = 1; // turbo: guidance off, so the negative encode is inert.
export const STARTER_SHIFT = 3.0;
export const STARTER_SAMPLER = 'euler';
export const STARTER_SCHEDULER = 'simple';

/** Fixed display estimate (post-paid has no exact pre-price — display only). A cheap Z-Image turbo gen runs in seconds. */
export const STARTER_ESTIMATE_BUZZ = 15;

// ── POST-PAID BUDGET (single engine) ──────────────────────────────────────────
// `maxBuzz` MUST equal `ceil(stepTimeoutSeconds × 1)` (asserted at registry load):
// the step `timeout` is the PHYSICAL cap (~1 Buzz/GPU-second). A cheap single-step
// Z-Image turbo gen finishes in seconds, so 30 is generous headroom while keeping a
// tight blast-radius ceiling. The router reserves this ceiling on every cap and
// settles-to-actual.
export const STARTER_BUDGET: { stepTimeoutSeconds: number; maxBuzz: number } = {
  stepTimeoutSeconds: 30,
  maxBuzz: 30,
};

// ─────────────────────────────────────────────────────────────────────────────
// Param schema — .strict(), no `engine` field (single fixed graph), no checkpoint
// (pinned policy). Mirrors seamless-pano's schema MINUS the engine axis. The
// account-type enum comes from the SAME source of truth (buzzSpendTypes) the block
// schema's `blockAccountTypeSchema` uses — imported directly (not from
// workflow.schema) to avoid a workflow.schema ⇄ recipes import cycle.
// ─────────────────────────────────────────────────────────────────────────────
export const starterComfyParamSchema = z
  .object({
    prompt: z.string().max(PROMPT_MAX),
    seed: z.coerce.number().int().nullish(),
    accountType: z.enum(buzzSpendTypes as [BuzzSpendType, ...BuzzSpendType[]]).optional(),
  })
  .strict();

export type StarterComfyParams = z.infer<typeof starterComfyParamSchema>;

/**
 * The single resolution of "which engine did this submit pick". A one-engine recipe
 * always resolves to the sentinel — kept as a method (not a constant) so the budget,
 * graph, estimate and settle-label all derive the engine the SAME way seamless-pano
 * does, so the CHARGED ceiling and the OBSERVED label can never drift.
 */
export function resolveEngine(_params: StarterComfyParams): StarterComfyEngine {
  return STARTER_COMFY_DEFAULT_ENGINE;
}

function resolveSeed(seed: number | null | undefined): number {
  return seed ?? Math.floor(Math.random() * 2_147_483_647);
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph builder — object construction only. The prompt is ALWAYS a leaf string
// value; there is NO string-templating of the graph structure (injection-safe by
// construction, plan §7-3). Simplest viable Z-Image txt2img: diffusion loader →
// aura-flow shift → clip → pos/neg encode → vae → empty latent → KSampler → decode
// → save.
// ─────────────────────────────────────────────────────────────────────────────
export function buildStarterTxt2imgGraph(params: StarterComfyParams): ComfyGraph {
  const seed = resolveSeed(params.seed);

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['1', 0], shift: STARTER_SHIFT },
    },
    '3': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: ZIMAGE_CLIP_AIR, type: 'lumina2', device: 'default' },
    },
    '4': {
      // Positive prompt — the raw user prompt as a LEAF string value.
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: params.prompt },
    },
    '5': {
      // Negative — inert at cfg 1 (guidance off), wired for graph completeness.
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: '' },
    },
    '6': {
      class_type: 'VAELoader',
      inputs: { vae_name: ZIMAGE_VAE_AIR },
    },
    '7': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: STARTER_WIDTH, height: STARTER_HEIGHT, batch_size: 1 },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['7', 0],
        seed,
        steps: STARTER_STEPS,
        cfg: STARTER_CFG,
        sampler_name: STARTER_SAMPLER,
        scheduler: STARTER_SCHEDULER,
        denoise: 1.0,
      },
    },
    '9': {
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['6', 0] },
    },
    '10': {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: 'starter' },
    },
  };
}

/**
 * The reusable graph-construction step. Returns the `customComfy` step INPUT
 * (`{ resources, trace, workflow }`). Only huggingface `staticAirs` — no gated
 * civitai versions, so the router's entitlement loop is skipped. Deliberately
 * separable from the `$type:'customComfy'` step wrapper so ONLY the wrapper (not
 * this graph) changes if a future prepaid path registers it as `$type:'comfy'`.
 */
function buildStep(params: StarterComfyParams): CustomComfyStepInput {
  return {
    resources: [ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR],
    trace: 'binary',
    workflow: buildStarterTxt2imgGraph(params),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipe definition.
// ─────────────────────────────────────────────────────────────────────────────
export const starterComfyTxt2imgRecipe: BlockRecipe<StarterComfyParams> = {
  id: 'starter-comfy-txt2img',
  paramSchema: starterComfyParamSchema,
  engines: STARTER_COMFY_ENGINES,
  resolveEngine,
  buildStep,
  resourceAllowlist: {
    // NO civitai resources (no checkpoints, no loras). Only huggingface AIRs —
    // exempt-by-construction (code-reviewed) → recipeCivitaiVersionIds() === [] →
    // the router's entitlement gate loop is skipped for this recipe.
    staticAirs: [ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR],
  },
  checkpointPolicy: 'pinned',
  // Single-engine post-paid budget: maxBuzz === ceil(stepTimeoutSeconds) (30 === 30),
  // asserted per-engine at registry load. See STARTER_BUDGET.
  budgetForEngine: () => STARTER_BUDGET,
  budgetFor: () => STARTER_BUDGET,
  estimateBuzz: () => STARTER_ESTIMATE_BUZZ,
  // Read by the router's prompt audit (a server-owned graph earns no moderation
  // bypass). The graph itself keeps the negative encode inert (cfg 1).
  negativePrompt: NEGATIVE_PROMPT,
};
