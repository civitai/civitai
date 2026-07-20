import type * as z from 'zod';
import { seamlessPano360Recipe } from './seamless-pano.recipe';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks `customComfy` recipe registry.
//
// A recipe bundles a fixed, server-authored ComfyUI graph builder with a bounded
// param schema, a fixed resource/AIR allowlist, a checkpoint policy, and — the
// load-bearing addition for the post-paid path — a declared `maxBuzz` ceiling
// backed by an aggressive step `timeout`. It is a CODE-REVIEWED, in-repo artifact
// (never runtime/DB-editable): the registry is the trust root (plan §3, §7).
//
// The block schema's `recipe` enum is DERIVED from this registry's keys
// (`REGISTERED_RECIPE_IDS`), so an unregistered recipe id fails closed at the
// wire schema. Adding a recipe = one small reviewed civitai PR: write a
// `<name>.recipe.ts`, register it below, add golden-graph tests. The `kind`
// (`customComfy`) and the SDK are untouched — only the recipe id enum widens.
//
// INERT/DARK: nothing here is wired into the live blocks.router submit/estimate
// path yet — PR6 (router + post-paid budget belt) is what will call `getRecipe`.
// ─────────────────────────────────────────────────────────────────────────────

/** A ComfyUI /prompt graph node: class_type + inputs, link refs `['id', slot]`. */
export type ComfyGraphNode = { class_type: string; inputs: Record<string, unknown> };
/** A ComfyUI /prompt graph: node-id keyed. */
export type ComfyGraph = Record<string, ComfyGraphNode>;

/**
 * The `$type:'customComfy'` step INPUT payload (`CustomComfyInput` in
 * @civitai/client): the AIR resource list + the raw graph + the trace mode. This
 * is the reusable graph-construction output — a future prepaid `$type:'comfy'`
 * path would wrap the SAME input differently, so keep it free of any
 * customComfy-step envelope concern.
 */
export type CustomComfyStepInput = {
  resources: string[];
  trace: 'binary';
  workflow: ComfyGraph;
};

/**
 * Resolved, entitlement-verified resources handed to a recipe's `buildStep`.
 * v1 (pinned policy) carries nothing — the recipe's graph uses fixed public
 * constants. A future user-picked-checkpoint policy would resolve the picked
 * checkpoint's AIR here AFTER the entitlement belt has run over it.
 */
export type ResolvedRecipeResources = {
  checkpointAir?: string;
};

/** A recipe-pinned civitai resource (checkpoint/LoRA) the entitlement belt gates. */
export type RecipeCivitaiResource = {
  modelId?: number;
  modelVersionId: number;
  baseModelGroup?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 RESOURCE INVARIANT (read before pinning ANY civitai model version below)
//
// A customComfy recipe MAY ONLY pin FULLY-PUBLIC, Published, NON-early-access,
// NON-Private model versions in its `resourceAllowlist` (checkpoints + loras).
//
// WHY this is a hard invariant and not just a preference: a raw customComfy step
// submits its `input.resources` AIR array DIRECTLY to the orchestrator, which
// BYPASSES `getGenerationResourceData`'s early-access / Private belt — that belt
// only runs over generation-GRAPH steps (textToImage/comfy), never over a
// hand-authored customComfy `resources` array. The router-side gate the belt
// leans on (`resolveCanGenerateForVersions` → `assertViewerCanGeneratePageResources`
// in blocks.router.ts `submitCustomComfyWorkflow`) covers baseline generatability
// (usageControl / covered / NSFW-tier) but does NOT currently cover early-access
// `hasAccess` NOR Private-model subscription entitlement. So a pinned early-access
// or Private version would run for viewers who have NOT paid for / been granted it
// — an entitlement bypass. Keep every pinned version Public + Published +
// non-early-access until that gate exists.
//
// v1 (`seamless-pano-360`): the pinned 360Redmond LoRA versions (model 118025) are
// verified Public / Published / non-early-access / non-Private — safe under this
// invariant.
//
// This is a DOC-INVARIANT, enforced by CODE REVIEW of each new recipe PR — NOT a
// module-load DB check (there is no DB in this module; the registry loads at
// import time, before any request context). A robust router-side early-access /
// Private / hasAccess gate for customComfy-resolved versions is separate pre-GA
// hardening.
//
// TODO(app-blocks customComfy pre-GA): add an early-access `hasAccess` +
// Private-subscription entitlement gate over `recipeCivitaiVersionIds(recipe)` in
// `submitCustomComfyWorkflow` (blocks.router.ts) so the invariant is ENFORCED at
// submit, not merely asserted by review — then this comment can relax to "prefer".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recipe contract (server-side, NEVER on the wire). `P` is the recipe's
 * bounded param type (inferred from `paramSchema`).
 */
export interface BlockRecipe<P = unknown> {
  /** Stable id; the schema's `recipe` enum is derived from the registry keys. */
  id: string;
  /** Bounded, `.strict()` Zod schema for the recipe's params. */
  paramSchema: z.ZodType<P>;
  /** Which engine variants this recipe exposes (drives which builder runs). */
  engines: readonly string[];
  /**
   * PURE builder: bounded params + resolved resources → the customComfy step
   * INPUT. Ported from panorama.ts; builds a ComfyGraph by OBJECT CONSTRUCTION
   * only (the prompt is a leaf string, never templated into the graph).
   */
  buildStep(params: P, resolved: ResolvedRecipeResources): CustomComfyStepInput;
  /** Every resource the recipe can reference, by role. v1 = fixed public models. */
  resourceAllowlist: {
    checkpoints?: RecipeCivitaiResource[];
    loras?: RecipeCivitaiResource[];
    /** huggingface AIRs the DiT engines pin (not gated civitai versions). */
    staticAirs: string[];
  };
  /** v1: 'pinned' (no user checkpoint). Follow-up: 'userPickedSdxl'. */
  checkpointPolicy: 'pinned' | 'userPickedSdxl';
  /** Hard per-job Buzz ceiling — MUST equal ceil(stepTimeoutSeconds × 1). */
  maxBuzz: number;
  /** The aggressive step timeout (seconds) that ENFORCES `maxBuzz` (plan §5). */
  stepTimeoutSeconds: number;
  /** Display-only estimate for estimateWorkflow (post-paid has no exact price). */
  estimateBuzz(params: P): number;
  /** Recipe-level negative prompt (the prompt-audit re-point reads this in PR6). */
  negativePrompt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBlockRecipe = BlockRecipe<any>;

// The registry object. Its keys ARE the source of truth for the schema enum.
const recipeRegistry = {
  'seamless-pano-360': seamlessPano360Recipe,
};

export type RegisteredRecipeId = keyof typeof recipeRegistry & string;

/**
 * The registered recipe ids, derived from the registry keys. Consumed by
 * `workflow.schema`'s `blockCustomComfyBodySchema` as the fail-closed `recipe`
 * enum (an unregistered id is rejected at the union). Typed as a non-empty tuple
 * so `z.enum` accepts it.
 */
export const REGISTERED_RECIPE_IDS = Object.keys(recipeRegistry) as [
  RegisteredRecipeId,
  ...RegisteredRecipeId[]
];

/** Resolve a recipe by id. Returns `undefined` for an unregistered id. */
export function getRecipe(id: string): AnyBlockRecipe | undefined {
  return (recipeRegistry as Record<string, AnyBlockRecipe>)[id];
}

/**
 * The civitai model-version ids a recipe pins (checkpoints + LoRAs). PR6's router
 * passes these through `resolveCanGenerateForVersions` /
 * `assertViewerCanGeneratePageResources` (blocks.router.ts) BEFORE emitting the
 * step — so the registry can't be quietly edited to point at a gated /
 * early-access / Private resource without the entitlement belt catching it. The
 * huggingface `staticAirs` are exempt-by-construction (no civitai entitlement).
 */
export function recipeCivitaiVersionIds(recipe: AnyBlockRecipe): number[] {
  const { checkpoints = [], loras = [] } = recipe.resourceAllowlist;
  return [...checkpoints, ...loras].map((r) => r.modelVersionId);
}

// Fail-fast the `maxBuzz == ceil(stepTimeoutSeconds)` invariant at module load —
// the safety argument (plan §5.4) depends on the step timeout physically capping
// the job at `maxBuzz`, so a recipe that declares a looser `maxBuzz` than its
// timeout enforces (or a tighter one it can't guarantee) is a build-time error,
// not a runtime surprise.
for (const [id, recipe] of Object.entries(recipeRegistry)) {
  const enforced = Math.ceil(recipe.stepTimeoutSeconds);
  if (recipe.maxBuzz !== enforced) {
    throw new Error(
      `recipe '${id}': maxBuzz (${recipe.maxBuzz}) must equal ceil(stepTimeoutSeconds) (${enforced}) — ` +
        'the step timeout is the physical Buzz ceiling (plan §5).'
    );
  }
}
