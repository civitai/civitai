import * as z from 'zod';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { REGISTERED_RECIPE_IDS } from '~/server/services/blocks/recipes';
import { REGISTERED_STEP_IDS } from '~/server/services/blocks/steps';
import type { BlockStepToolCall } from '~/server/services/blocks/steps';
import {
  civitaiHostedImageUrlSchema,
  SOURCE_IMAGE_URL_MAX,
} from '~/server/schema/blocks/civitai-image-url';
import type { ModelSubstitutionReason } from '~/shared/data-graph/generation/model-substitution';

// The spendable buzz account types a viewer may pick for a (money) page block.
// Reuse the authoritative `buzzSpendTypes` (blue/green/yellow — `red` is
// disabled and filtered out) rather than a fresh literal so this stays in sync
// with the buzz-constants source of truth. The domain-maturity policy still
// CLAMPS which of these is actually spendable per-request in blocks.router
// (SFW → blue/green, mature → blue/yellow) — this enum only bounds the wire
// surface; it never widens the allowed set.
const blockAccountTypeSchema = z.enum(buzzSpendTypes as [BuzzSpendType, ...BuzzSpendType[]]);

// `textToImage` is the block-supported kind. It now covers the whole IMAGE
// workflow class (App Blocks IMAGE bridge): a bare body maps to a `txt2img`
// graph workflow, and a body carrying a bounded `sourceImage` maps to an img2img
// workflow whose variant is chosen from the checkpoint's ecosystem — `img2img`
// (SD-family) or `img2img:edit` (edit-capable: OpenAI/Qwen/Flux Kontext/…). See
// buildImageWorkflowInput / BLOCK_IMAGE_WORKFLOW_TYPES in
// workflow.service. A later phase adds a NON-image media class (video/audio/3D)
// as a NEW discriminated-union `kind` here, which must also (a) extend the
// discriminator in blocks.router workflow procedures, (b) be exposed by
// @civitai/app-sdk's useBuzzWorkflow contract.
//
// `customComfy` is the second `kind` (App Blocks customComfy bridge, v1). Unlike
// `textToImage` (which maps a bounded body onto a generation GRAPH the server
// builds), a `customComfy` body carries only a server-side `recipe` id + opaque
// `params` — the server owns the ComfyUI graph in full (a fixed, code-reviewed
// recipe from `~/server/services/blocks/recipes`). The wire schema does only the
// COARSE fail-closed gate here: `recipe` MUST be a registered id
// (REGISTERED_RECIPE_IDS, derived from the recipe registry keys) and `params` is
// an opaque record; the per-recipe `.strict()` param schema is applied in the
// TRANSLATOR (workflow.service `buildCustomComfyWorkflowInput`), not here, so the
// wire surface stays recipe-agnostic. Mirrors `@civitai/app-sdk`'s
// `WorkflowBodyCustomComfy` (civitai-app-starters PR #171) — keep the two in
// lockstep.
//
// LIVE: blocks.router now branches on `kind==='customComfy'` in BOTH
// `estimateWorkflow` and `submitWorkflow` (see `estimateCustomComfyWorkflow` /
// `submitCustomComfyWorkflow`), backed by the post-paid budget belt
// (`settleCustomComfySpend`) and the `buildCustomComfyWorkflowInput` translator.
// The earlier "INERT/DARK — router handles ONLY textToImage" note is obsolete;
// both members of this union are wired end-to-end.
//
// Caps are intentionally tighter than the platform-wide generateImageSchema —
// blocks run in untrusted iframes and the token issuer caps per-call buzz at
// BUZZ_BUDGET_CAP=1000, so wide-open quantity/dimensions wouldn't be honored
// anyway. Trim the surface area at the boundary instead of relying on
// downstream gates.

const PROMPT_MAX = 1500;
const NEG_PROMPT_MAX = 1500;
// Exported so the client-side generationSource upload modal
// (BlockGenerationSourceUploadModal) can downscale a chosen image to fit the
// SAME bounds the sourceImage schema enforces BEFORE upload — a single source of
// truth, so the client resize target can never drift from the server clamp.
export const DIM_MIN = 64;
export const DIM_MAX = 2048;
const STEPS_MAX = 50;
const QUANTITY_MAX = 4;
const CLIP_SKIP_MAX = 12;
// Bound for the opaque published-content-author key (`sharedContentKey`).
// Matches the shared-storage key shape (apps-shared.router `sharedKeyInput`
// is ≤64) so a server-ULID row key or an app counter key both fit.
const SHARED_CONTENT_KEY_MAX = 64;

// Page-LoRA caps (App Blocks Page-LoRA, Increment 1). Intentionally tighter
// than the platform per-tier resource cap — these come from an untrusted
// iframe, so bound the resource fan-out + strength at the boundary rather than
// relying on the downstream orchestrator belt. A page block sends the
// additional resources (LoRA version ids) it obtained out-of-band (author-
// curated or user-pasted); the server re-derives type/baseModel/entitlement
// from each version id (no per-LoRA modelId binding — pages have no JWT model
// binding). `epochNumber` is intentionally OMITTED in v1: epochs imply
// Private/subscription resources and add a subscription dimension we defer.
export const MAX_ADDITIONAL_RESOURCES = 5;
export const LORA_STRENGTH_MIN = -1;
export const LORA_STRENGTH_MAX = 2;

const blockAdditionalResourceSchema = z.object({
  modelVersionId: z.number().int().positive(),
  // Strict (non-coerced) parity with modelVersionId. Block bodies are JSON, so
  // strength arrives as a real number; z.coerce would let `""`/`[]`/`true`/null
  // slip through to 0/1 instead of being rejected.
  strength: z.number().min(LORA_STRENGTH_MIN).max(LORA_STRENGTH_MAX).default(1),
});

// ── img2img source image (App Blocks IMAGE bridge, Phase-2a) ─────────────────
// The block body is UNTRUSTED iframe input, so an init/source image MUST NOT be
// an arbitrary remote URL the generator would fetch (SSRF / arbitrary-fetch).
// It is bounded to a Civitai-controlled host by `civitaiHostedImageUrlSchema`.
//
// 🔴 That predicate MOVED — unchanged — to `~/server/schema/blocks/civitai-image-url`,
// which is where its full reasoning now lives (hostname-not-substring, the two
// WHATWG parser-differential classes it closes, and the canonicalize-what-you-
// validate rule). It moved because the `kind: 'step'` registry needs the SAME
// bound for every step type that takes an image URL (`convert-image` today) and
// cannot import this module — this module imports the registry to derive its
// wire enums, so it would be a cycle. One rule, one place.
//
// Re-exported here because `SOURCE_IMAGE_URL_MAX` was part of this module's
// public surface before the move.
export { SOURCE_IMAGE_URL_MAX };

const blockSourceImageSchema = z.object({
  url: civitaiHostedImageUrlSchema,
  // Dimension hints for the graph's denoise/aspect derivation. Bounded to the
  // same block caps as params so an iframe can't send absurd dimensions.
  width: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX),
  height: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX),
});

export type BlockSourceImage = z.infer<typeof blockSourceImageSchema>;

// ── Multi-image conditioning (App Blocks IMAGE bridge) ───────────────────────
// ABSOLUTE wire bound on `sourceImages`, NOT the real cap. The real cap is
// PER-ECOSYSTEM and derived from the graph's own `imagesNode` config at build
// time (`getImagesLimit` — Boogu/Kontext/MAI/SD-family 1, Qwen/Qwen2/MageFlow
// 3, Reve/HiDream-O1 4, WanImage 5, Flux.2/Klein/OpenAI/NanoBanana/Seedream/
// Grok 7). This constant only stops an untrusted iframe from posting an
// unbounded array before the body is even parsed — it is set ABOVE the largest
// per-ecosystem cap on purpose so a future ecosystem raising its own limit is
// not silently clamped here. Every element is validated individually against
// `blockSourceImageSchema` (Civitai-host + dimension bounds), never just [0].
export const BLOCK_SOURCE_IMAGES_WIRE_MAX = 10;

const blockTextToImageBodySchema = z.object({
  kind: z.literal('textToImage'),
  modelId: z.number().int().positive(),
  modelVersionId: z.number().int().positive(),
  // Optional LoRA stack (Increment 1, LoRA-only v1). Each entry resolves to a
  // LoRA-type model version that the server entitlement-gates per-resource and
  // base-model-family-matches against the checkpoint before any spend. Capped
  // at MAX_ADDITIONAL_RESOURCES for the iframe posture above.
  additionalResources: z
    .array(blockAdditionalResourceSchema)
    .max(MAX_ADDITIONAL_RESOURCES)
    .optional(),
  // Optional img2img init/source image (App Blocks IMAGE bridge).
  // When present, the block bridge emits an img2img graph workflow whose VARIANT
  // is chosen from the checkpoint's ecosystem (buildImageWorkflowInput /
  // resolveBlockImageWorkflowType): SD-family ecosystems → `img2img` ("Image
  // Variations"); edit-capable ecosystems (OpenAI/Qwen/Flux Kontext/… —
  // EDIT_IMG_IDS) → `img2img:edit`; when absent, behavior is byte-identical to
  // before (txt2img). Bounded to a Civitai-hosted image (see
  // blockSourceImageSchema) — never an arbitrary remote URL.
  //
  // Two scope limits are enforced downstream (NOT at the wire schema, which only
  // bounds shape): (1) blocks.router rejects `sourceImage` on a MODEL-bound token
  // — img2img is PAGE-only, mirroring `additionalResources`; (2)
  // buildImageWorkflowInput rejects fail-closed a checkpoint whose ecosystem
  // supports NEITHER img2img variant (deterministically via `isWorkflowAvailable`,
  // never relying on the graph's safeParse auto-correction).
  //
  // 🔴 DEPRECATED ALIAS — kept working indefinitely. The published developer
  // docs and `@civitai/app-sdk` both ship `sourceImage` today, so removing it
  // would break every deployed block. `sourceImages` (below) is the current
  // field; the server normalizes the singular into a 1-element array
  // (`normalizeBlockSourceImages`) and everything downstream sees only arrays.
  sourceImage: blockSourceImageSchema.optional(),
  // Multi-image conditioning. The graph layer has always supported N images
  // (`imagesNode({ min, max, slots })`); the block bridge could only ever
  // express one. Each element is validated INDIVIDUALLY (Civitai-hosted https
  // host check + DIM_MIN/DIM_MAX bounds) — the array form has exactly the same
  // per-image posture as the singular one, with no "first element only" gap.
  //
  // Bounds: `.min(1)` — an EMPTY array is REJECTED rather than silently treated
  // as "no source image". A caller that sends `sourceImages: []` computed an
  // empty list and meant to send images; quietly downgrading that to a txt2img
  // generation would bill them for something they did not ask for, which is the
  // silent-wrong-answer failure mode this bridge has already been bitten by.
  // Omit the field entirely for txt2img. `.max()` is the absolute wire bound —
  // the REAL cap is per-ecosystem and enforced in buildImageWorkflowInput.
  //
  // Supplying BOTH `sourceImage` and `sourceImages` is rejected as ambiguous
  // (see the union-level check below) rather than picking a winner.
  sourceImages: z
    .array(blockSourceImageSchema)
    .min(1, 'sourceImages must not be empty — omit the field for text-to-image')
    .max(BLOCK_SOURCE_IMAGES_WIRE_MAX)
    .optional(),
  // Optional viewer-picked buzz account to spend (money page blocks). Absent →
  // unchanged Auto behavior (domain-allowed currencies drained blue-first). When
  // present, blocks.router moves it to the FRONT of the domain-allowed currency
  // order (preferred-first, then fall back) and REJECTS it if it's outside the
  // domain-allowed set — the maturity policy is never widened here. See
  // `resolveBlockCurrenciesForAccount`.
  accountType: blockAccountTypeSchema.optional(),
  // Optional GENERIC published-content-author attribution basis. The opaque
  // shared-storage `key` of the cross-user published content this generation
  // is running on behalf of — the app supplies it out-of-band from its own
  // shared storage (`app_<slug>.shared_kv`). When present, the server resolves
  // it (SERVER-SIDE, off the submit critical path) to the content's AUTHOR and
  // records that user as the payout basis on the spend-attribution row. Purely
  // opaque + advisory here: this is NEVER trusted as an author (the author is
  // re-derived from the key server-side), so a forged key can at worst point at
  // a non-existent row (→ no attribution). Bounded to the same key shape as the
  // shared-storage surface (≤64). Omit when N/A — behavior is unchanged.
  // FULLY GENERIC: any app that publishes cross-user content can send it — not
  // tied to any one app kind.
  sharedContentKey: z.string().min(1).max(SHARED_CONTENT_KEY_MAX).optional(),
  params: z.object({
    prompt: z.string().max(PROMPT_MAX).default(''),
    negativePrompt: z.string().max(NEG_PROMPT_MAX).optional(),
    cfgScale: z.coerce.number().min(1).max(30).optional(),
    sampler: z.string().min(1).max(64).optional(),
    steps: z.coerce.number().int().min(1).max(STEPS_MAX).optional(),
    seed: z.coerce.number().int().nullish(),
    width: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
    height: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
    // SD/SDXL per-resource convention. Flux ignores it. Cap at 12 (the
    // platform-wide constant in generation.constants.ts).
    clipSkip: z.coerce.number().int().min(0).max(CLIP_SKIP_MAX).optional(),
    quantity: z.coerce.number().int().min(1).max(QUANTITY_MAX).default(1),
  }),
});

// Supplying BOTH the deprecated `sourceImage` and the current `sourceImages` is
// AMBIGUOUS — we refuse rather than pick a winner. Silently preferring one is
// exactly how a caller ends up conditioning on an image it thought it had
// replaced. Enforced at the WIRE schema so both `estimateWorkflow` and
// `submitWorkflow` inherit it from the single parse, with no way to reach the
// translator holding both.
const blockTextToImageBodySchemaChecked = blockTextToImageBodySchema.refine(
  (body) => !(body.sourceImage && body.sourceImages),
  {
    path: ['sourceImages'],
    message:
      'send either `sourceImage` (deprecated) or `sourceImages`, not both — they are ambiguous together',
  }
);

// ── customComfy: ARM-AWARE REJECTION MESSAGES ────────────────────────────────
//
// 🔴 MESSAGE QUALITY ONLY. Nothing below widens or narrows what parses — both
// arms keep `.strict()` and every field bound is untouched. These helpers only
// replace the TEXT of two issue kinds the union itself raises.
//
// WHY. `customComfy` is a nested discriminated union whose two arms are the
// whole feature, and until now a body that landed on the wrong arm was told
// only the name of the key that offended it:
//
//   { kind:'customComfy', recipe:'…', graph:{…}, params:{…} }
//   → `Unrecognized key: "graph"`
//
// That answer is CORRECT — keeping `recipe` pins the recipe arm and `.strict()`
// refuses `graph` — and it is also how a blind-dogfooding developer concluded
// the inline arm did not exist on the wire at all, and built a workaround. The
// union knows BOTH of its arms at rejection time; every other rejection on this
// platform enumerates what IS valid (an unregistered recipe id lists the
// registered recipes, an unregistered step id lists the registered steps, a
// malformed AIR prints the AIR grammar), and this was the one place that did
// not.
//
// 🔴 THE ENUMERATION IS DERIVED FROM THE ARM'S OWN SHAPE, NEVER HAND-WRITTEN.
// That is a SAFETY property, not just DRY. The orchestrator's `CustomComfyInput`
// carries fields an app must never set (see the `.strict()` note on the inline
// arm below); those fields are by construction ABSENT from both shapes, so a
// list derived from `Object.keys(shape)` cannot name one. A hand-written list
// could — and would turn a helpful error into a map of the internal payload.
// It also cannot rot: adding a public field to an arm updates the message.
//
// COST: these run only on a REJECTED body. Nothing extra happens on the happy
// path — no second parse, no round-trip.
const customComfyRecipeShape = {
  kind: z.literal('customComfy'),
  mode: z.literal('recipe').optional(),
  recipe: z.enum(REGISTERED_RECIPE_IDS),
  params: z.record(z.string(), z.unknown()),
};

/**
 * The public wire keys of one `customComfy` arm, in declaration order.
 *
 * Declared as a hoisted function, not a const, because `inlineComfyShape` is
 * defined further down the file — the body only ever runs while formatting a
 * rejection, long after module init, so the forward reference is safe.
 */
function customComfyArmKeys(arm: 'recipe' | 'inline'): string {
  const shape = arm === 'recipe' ? customComfyRecipeShape : inlineComfyShape;
  return Object.keys(shape).join(', ');
}

/** One-line description of an arm, used in both directions of the cross-reference. */
function customComfyArmHelp(arm: 'recipe' | 'inline'): string {
  return arm === 'recipe'
    ? `mode:"recipe" (the default when \`mode\` is omitted) runs a server-registered recipe by id and accepts only: ${customComfyArmKeys(
        'recipe'
      )}`
    : `mode:"inline" carries the ComfyUI graph itself — the graph goes under \`workflow\` — and accepts only: ${customComfyArmKeys(
        'inline'
      )}`;
}

/**
 * Error map for ONE arm's `.strict()` rejection: name the arm the body landed
 * on, list that arm's keys, and point at the other arm.
 *
 * Returns `undefined` for every other issue code so zod falls through to its own
 * message — a bad `maxBuzz` still reports `Too big: …` at `path:['maxBuzz']`,
 * unchanged.
 */
function customComfyArmErrorMap(arm: 'recipe' | 'inline') {
  const other = arm === 'recipe' ? 'inline' : 'recipe';
  return (iss: { code?: string; keys?: unknown }): string | undefined => {
    if (iss.code !== 'unrecognized_keys') return undefined;
    const keys = Array.isArray(iss.keys) ? iss.keys : [];
    const named = keys.map((k) => `"${String(k)}"`).join(', ');
    return (
      `Unrecognized key${keys.length === 1 ? '' : 's'} on a \`customComfy\` ${arm} body: ${named}` +
      ` — a \`customComfy\` body has two forms. ${customComfyArmHelp(arm)}.` +
      ` ${customComfyArmHelp(other)}.`
    );
  };
}

// App Blocks customComfy bridge (v1). Coarse fail-closed wire gate only:
//  - `recipe` MUST be a REGISTERED recipe id (derived from the recipe registry
//    keys) — an unregistered id is rejected at the union, before any translator
//    or orchestrator call.
//  - `params` is an opaque `Record<string, unknown>` here; the per-recipe
//    `.strict()` param schema (prompt/seed/engine/accountType bounds) is applied
//    in the translator (`buildCustomComfyWorkflowInput`), which is the single
//    place a recipe's real param contract lives.
//  - `.strict()` rejects any extra top-level field on the body.
//  - `mode` is the ARM discriminator, and on this arm it is an OPTIONAL literal
//    so an existing body that omits it (every deployed app, every published
//    `@civitai/app-sdk` body) still lands here. See the union at the bottom of
//    this file for why `.optional()` and not `.default()` — the difference is
//    load-bearing and was measured, not assumed.
export const blockCustomComfyBodySchema = z
  .object(customComfyRecipeShape, { error: customComfyArmErrorMap('recipe') })
  .strict();

// ── App Blocks customComfy INLINE-GRAPH arm (`kind:'customComfy'`, `mode:'inline'`) ──
//
// The SECOND arm of the `customComfy` member. Where the recipe arm names one of
// two server-authored graphs, this one carries the ComfyUI graph ITSELF, so an
// app can ship a workflow the registry does not contain. The recipe arm above is
// UNCHANGED and stays the default: a body with no `mode` is a recipe body and
// parses byte-identically to before.
//
// 🔴 WHAT THE RECIPE ARM PROVIDED THAT THIS ONE MUST REPLACE. A recipe is a
// CODE-REVIEWED in-repo artifact, and that review was the trust root for three
// separate things. An inline graph has no review, so each is replaced by a
// mechanical gate — see `services/blocks/inline-comfy.service`:
//   1. `resourceAllowlist` (only fully-public pinned versions) → a real
//      entitlement belt over the app-supplied `resources` array, which folds
//      early-access `hasAccess` and Private-subscription.
//   2. `paramSchema.prompt` (the field `auditPromptServer` reads) → a sweep of
//      every string leaf in the graph, audited alongside the declared prompt. An
//      inline graph carries its prompts inside `CLIPTextEncode` nodes, so
//      auditing a declared field ALONE would make moderation a silent no-op.
//   3. `budgetFor()` (the `maxBuzz === ceil(stepTimeoutSeconds)` ceiling) → the
//      app declares `maxBuzz` and the server derives
//      `stepTimeoutSeconds = maxBuzz`. The invariant then holds BY CONSTRUCTION
//      — there is only one number — and the whole post-paid spend belt (static
//      gate, both reservations, settle-to-actual) is reused untouched.
//
// 🔴 `.strict()` IS LOAD-BEARING HERE, NOT HYGIENE. The orchestrator's
// `CustomComfyInput` carries fields an app must NEVER set — `sessionOwnerApiToken`
// (a Civitai API token forwarded to the claiming worker), `comfyImage` (an OCI
// image AIR, i.e. an arbitrary container), `minVramGb` (changes the worker tier
// and therefore the Buzz/second rate the whole ceiling argument rests on),
// `sessionId`, `useSageAttention`, `minimumDurationSeconds`. The step input is
// CONSTRUCTED SERVER-SIDE from an allowlisted set of fields; the app's body is
// never spread into it. `.strict()` is the second belt: an app that sends one of
// those names is rejected at the wire rather than silently ignored.

/**
 * Hard per-job Buzz ceiling an inline body may declare.
 *
 * DERIVED, not invented. This surface is developer-only (`assertViewerIsAppDeveloper`
 * gates every customComfy submit), and the developer path's own per-call budget
 * ceiling is `DEV_BUZZ_BUDGET_CAP` (250) in `services/blocks/dev-scoped-mint.service`
 * — a declared `maxBuzz` above that is unreachable through a dev token anyway,
 * because the router's static gate fail-snapshots on `ceiling > claims.buzzBudget`.
 * It also sits comfortably above the largest shipped recipe ceiling (180, the
 * `qwen-image` engine of `seamless-pano-360`) so an inline graph is not more
 * constrained than a recipe.
 *
 * Deliberately a LITERAL here rather than an import: this module is imported by
 * the wire layer and must stay import-light, while `dev-scoped-mint.service`
 * pulls in the block-token service. `inline-comfy-budget.test.ts` imports both
 * and pins them equal, so the derivation cannot drift silently.
 */
export const INLINE_MAX_BUZZ = 250;

/** Max AIR URNs an inline body may declare. Bounds the entitlement fan-out. */
export const INLINE_RESOURCES_MAX = 24;
/** Max characters in a single declared AIR URN. */
const INLINE_AIR_MAX_LEN = 512;
/** Max nodes in an inline graph. */
export const INLINE_GRAPH_NODES_MAX = 300;
/**
 * Max serialized bytes of an inline graph.
 *
 * Two jobs. (1) Payload DoS: `workflow` is an unbounded `Record<string, unknown>`
 * on a submit path, so without this a single request can be arbitrarily large.
 * (2) It is what BOUNDS THE MODERATION SWEEP — the prompt audit walks every
 * string leaf in the graph, so an unbounded graph would be an unbounded audit
 * payload. Real ComfyUI graphs are single-digit to low-tens of KB; 256 KB is
 * generous for a graph and still a hard bound.
 */
export const INLINE_GRAPH_BYTES_MAX = 256 * 1024;

/** A ComfyUI `/prompt` graph node on the wire: `class_type` + `inputs`. */
const inlineComfyNodeSchema = z
  .object({
    class_type: z.string().min(1).max(128),
    inputs: z.record(z.string(), z.unknown()),
  })
  .strict();

// 🔴 EXTRACTED AS A NAMED SHAPE, not inlined into `z.object({…})`, so
// `customComfyArmKeys('inline')` can enumerate this arm's PUBLIC keys in a
// rejection message without a hand-written list that could drift — or name one
// of the fields `.strict()` exists to refuse. See the ARM-AWARE REJECTION
// MESSAGES block above the recipe arm.
const inlineComfyShape = {
  kind: z.literal('customComfy'),
  // The arm discriminator. A LITERAL rather than "has a `workflow` key" so the
  // two arms can never both match, the rejection names the arm, and a future
  // field addition to either arm cannot silently change which one a body hits.
  mode: z.literal('inline'),
  workflow: z.record(z.string(), inlineComfyNodeSchema),
  // The orchestrator's DECLARED DOWNLOAD MANIFEST. The graph itself is opaque
  // to the orchestrator ("Forwarded opaquely to the worker; the orchestrator
  // does not inspect or validate node contents" — `CustomComfyInput.workflow`),
  // so this flat array is the entire untrusted entitlement surface. Gated by
  // `assertViewerEntitledToInlineResources`; ALSO cross-checked for containment
  // against AIRs appearing in the graph, so the "opaque" claim is not
  // load-bearing.
  resources: z.array(z.string().min(1).max(INLINE_AIR_MAX_LEN)).max(INLINE_RESOURCES_MAX),
  // Declared so an app can surface what it asked for. NOT trusted as the
  // complete moderation surface — the graph is swept too (see above).
  prompt: z.string().max(PROMPT_MAX).default(''),
  negativePrompt: z.string().max(NEG_PROMPT_MAX).default(''),
  // The ONLY spend knob. The server derives `stepTimeoutSeconds = maxBuzz` and
  // stamps it as the step timeout, which is the PHYSICAL cap.
  maxBuzz: z.number().int().min(1).max(INLINE_MAX_BUZZ),
};

export const blockInlineComfyBodySchema = z
  .object(inlineComfyShape, { error: customComfyArmErrorMap('inline') })
  .strict()
  .refine((b) => Object.keys(b.workflow).length > 0, {
    path: ['workflow'],
    message: 'inline workflow must contain at least one node',
  })
  .refine((b) => Object.keys(b.workflow).length <= INLINE_GRAPH_NODES_MAX, {
    path: ['workflow'],
    message: `inline workflow may contain at most ${INLINE_GRAPH_NODES_MAX} nodes`,
  })
  .refine((b) => JSON.stringify(b.workflow).length <= INLINE_GRAPH_BYTES_MAX, {
    path: ['workflow'],
    message: `inline workflow exceeds the ${INLINE_GRAPH_BYTES_MAX}-byte limit`,
  });

// ── App Blocks STEP-TYPE bridge (`kind: 'step'`) — RFC #3515 migration step 1 ──
//
// The THIRD union member, added ALONGSIDE the existing two. `textToImage` and
// `customComfy` are untouched: this member only ADDS a discriminant, so every
// deployed block and every published `@civitai/app-sdk` body keeps parsing and
// behaving exactly as before.
//
// Where the other two members each hand-wrote a capability, this one is
// REGISTRY-BACKED: `step` must be a registered id (`REGISTERED_STEP_IDS`,
// derived from the step-registry keys), and everything about the capability —
// its bounded params, its billing mode, its moderation posture, its builder —
// lives in that entry. Adding a capability is a registry entry, not a new union
// member and not a router branch. That is the point: sibling union members are
// what make consolidation a breaking change for every published app once the
// wire contract is public.
//
// The wire gate here is deliberately COARSE, exactly mirroring `customComfy`:
//  - `step` MUST be a REGISTERED id — an unregistered id is rejected AT THE
//    UNION, before any translator, any spend reservation, or any orchestrator
//    call. Fail-closed at the schema.
//  - `params` is an opaque `Record<string, unknown>` here; the per-step
//    `.strict()` param schema is applied by the handler, which is the single
//    place a step's real param contract lives. That keeps the wire surface
//    step-agnostic, so registering a step never edits this file.
//  - `.strict()` rejects any extra top-level field on the body.
//
// 🔴 `customComfy` is NOT migrated behind the registry here. That is the RFC's
// migration step 3 (with `kind: 'customComfy'` retained as a deprecated alias)
// and is deliberately out of scope — step 1 is "land the registry alongside the
// existing members; nothing breaks".
//
// Built through a FACTORY rather than inline so the "enum is derived from the
// registry, not hardcoded" property is directly testable: a test can build the
// same schema over a widened id list and assert the enum grew.
export function makeBlockStepBodySchema(stepIds: [string, ...string[]]) {
  return z
    .object({
      kind: z.literal('step'),
      step: z.enum(stepIds),
      params: z.record(z.string(), z.unknown()),
    })
    .strict();
}

export const blockStepBodySchema = makeBlockStepBodySchema(REGISTERED_STEP_IDS);

export type BlockWorkflowBody = z.infer<typeof blockWorkflowBodySchema>;

// 🔴 THE `customComfy` MEMBER IS A NESTED DISCRIMINATED UNION ON `mode`, AND THE
// RECIPE ARM'S `mode` IS `.optional()` — NOT `.default('recipe')`. That
// distinction is the whole reason this comment exists. MEASURED against zod
// 4.0.17; each of the three obvious spellings was run, not reasoned about:
//
//   1. `blockInlineComfyBodySchema` as a FOURTH option of the outer union throws
//      at parse time: `Duplicate discriminator value "customComfy"`. zod's
//      discriminated union is a value→schema MAP, so two members cannot share a
//      `kind`.
//   2. Nesting on `mode` with the recipe arm declaring
//      `mode: z.literal('recipe').default('recipe')` CONSTRUCTS fine — and then
//      REJECTS EVERY DEPLOYED RECIPE BODY with `No matching discriminator`. zod
//      reads the discriminator value off the SCHEMA and does not see it through
//      a `.default()`, so `{kind:'customComfy', recipe, params}` (no `mode` key
//      — what every shipped app and every published `@civitai/app-sdk` sends)
//      fails. 🔴 THIS IS THE DANGEROUS ONE: it type-checks, it builds, its own
//      tests pass, and it breaks production.
//   3. Wrapping the whole thing in a plain `z.union([discriminatedUnion, inlineArm])`
//      parses every body correctly, but DEGRADES THE ERROR SHAPE: a rejected body
//      reports a single top-level `invalid_union` issue with `path: []` instead of
//      the precise `path: ['step']` / `path: ['recipe']` the discriminated union
//      produces. That is the diagnostic an app author gets for a bounced submit,
//      and `workflow.schema.step.test.ts` already pins it.
//
// `.optional()` works where `.default()` does not: zod treats `undefined` as a
// legitimate discriminator value for the arm, so a body with no `mode` key lands
// on the recipe arm, and the outer union stays a real discriminated union with
// its per-field error paths intact.
//
// Both arms are `.strict()`, so a body naming BOTH `recipe` and `workflow` is
// rejected by both and there is no ambiguity to resolve.
//
// Pinned by `workflow.schema.inline-comfy.test.ts` (recipe / textToImage / step
// bodies parse unchanged, output byte-identical) and by the existing
// `workflow.schema.step.test.ts` error-path assertion. Failure mode 2 above is
// covered by a mutation in the sweep: swapping `.optional()` for `.default()`
// turns the back-compat test red.
//
// The third rejection this member owns is an UNKNOWN `mode` (neither absent,
// `'recipe'` nor `'inline'`), which zod reports as a bare `Invalid input` at
// `path:['mode']` — the discriminator's own value is the one thing that error
// does not name. Same treatment as the two `.strict()` maps: enumerate the arms.
const blockCustomComfyMemberSchema = z.discriminatedUnion(
  'mode',
  [blockCustomComfyBodySchema, blockInlineComfyBodySchema],
  {
    error: (iss) => {
      if (iss.code !== 'invalid_union') return undefined;
      const raw = (iss.input as { mode?: unknown } | null | undefined)?.mode;
      const named = typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw ?? null);
      return (
        `Invalid \`customComfy\` mode: ${named} — expected "recipe" or "inline".` +
        ` ${customComfyArmHelp('recipe')}. ${customComfyArmHelp('inline')}.`
      );
    },
  }
);

export const blockWorkflowBodySchema = z.discriminatedUnion('kind', [
  blockTextToImageBodySchemaChecked,
  blockCustomComfyMemberSchema,
  blockStepBodySchema,
]);

// Mirrors BlockWorkflowSnapshot in @civitai/app-sdk's blocks/types.ts.
// Keep field names in lockstep — this is the wire contract the iframe consumes.
//
// `autoClaim` is set when the host opportunistically claimed a Buzz reward
// on the user's behalf during submit (currently only `dailyBoost`). The block
// uses this to surface a "+25 daily boost claimed!" notice; it's purely
// informational, never carries state the block must reconcile.
export type BlockWorkflowSnapshot = {
  workflowId: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'canceled';
  cost?: { total: number };
  imageUrls?: string[];
  error?: string;
  // The buzz account that primarily funded this generation (the accountType of
  // the largest realized debit). OPTIONAL + additive: existing consumers that
  // don't read it are unaffected. Only the account TYPE is surfaced — nothing
  // beyond what `cost.total` already implies. Absent on estimates, cache-hits,
  // or any snapshot the orchestrator returned without transactions.
  spentAccountType?: BuzzSpendType;
  autoClaim?: {
    type: 'dailyBoost';
    amount: number;
    accountType: 'yellow' | 'blue' | 'red' | 'green';
  };
  /**
   * Checkpoint versions the generation graph SILENTLY replaced (issue #3520).
   *
   * On a `modelLocked` ecosystem the graph swaps any version id that is not in
   * the current workflow's visible list for that workflow's default, returns
   * success, and bills the user. That is deliberate graceful degradation — it is
   * what keeps an app pinned to a since-retired version working instead of
   * hard-failing — but through this bridge the id was DELIBERATE and the
   * correction was previously undetectable. `requested` is what the block asked
   * for, `applied` is what actually ran.
   *
   * 🔴 BEHAVIOUR IS UNCHANGED: the same model runs as before; this field only
   * reports it. OPTIONAL + additive, and OMITTED entirely when nothing was
   * substituted, so every existing snapshot stays byte-identical and a consumer
   * that does not read it is unaffected.
   *
   * WHERE IT APPEARS. 🔴 ON THE `kind: 'textToImage'` PATH ONLY. That is the
   * only wire body whose handler resolves a checkpoint through the generation
   * graph (`createBlockTextToImageStep` → `buildGenerationContext`), so it is
   * the only one that can substitute anything. On that path: the submit reply,
   * the `estimateWorkflow` reply, EVERY reply from `submitWorkflow` that quotes
   * a cost without submitting (insufficient per-call budget, the per-user daily
   * / review Buzz cap, the per-app aggregate spend+velocity cap, the dev-tunnel
   * session cap), and — because the submit persists it on the orchestrator
   * workflow's `metadata` — every subsequent `pollWorkflow` / `cancelWorkflow`
   * read of that workflow. The poll is the one that matters in practice: it is
   * the snapshot carrying `imageUrls`, i.e. the one a block actually renders
   * from, so the record is present next to the images it describes rather than
   * only on a reply the block may have discarded.
   * The estimate reply is the exception — a whatIf creates no persisted workflow,
   * so there the record exists only on that reply.
   *
   * 🔴 IT DOES **NOT** APPEAR ON `kind: 'customComfy'` OR `kind: 'step'`. Each of
   * those has its own four cost-quoting exits, and none of the eight carries this
   * field — correctly, because neither handler builds a generation context: a
   * customComfy body binds a server-authored recipe and a registry step carries
   * no model binding at all, so there is nothing to substitute and nothing to
   * report.
   *
   * 🔴 IF YOU ARE EXTENDING A STEP TO RESOLVE A CHECKPOINT THROUGH THE GRAPH,
   * READ THIS. The paragraph above is a statement about the txt2img handler's
   * plumbing, NOT a property of the bridge — do not assume the field will flow
   * on your path because it flows there. The READ half is kind-agnostic (the
   * poll recovers the record from `workflow.metadata` for any workflow), but the
   * WRITE half is per-handler: your handler must pass the request's collector to
   * `snapshotFromWorkflow(..., { modelSubstitutions })` on the reply AND write
   * `WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY` into the submitted
   * `body.metadata`, or the substitution stays exactly as unobservable as it was
   * before #3520 — on the one surface #3520 exists to make observable.
   * `submitStepWorkflow` does neither today. Pinned by
   * `generation-surface-wiring.test.ts` (every `buildGenerationContext` call site
   * enumerated from the tree and pinned to its ENCLOSING FUNCTION, so a new one
   * inside a step handler fails there) and by the `kind:'step'` absence tests +
   * their planted-metadata control in `blocks.router.workflow.test.ts`.
   *
   * 🔴 WIRE CONTRACT: this is an ADDITIVE field on the type
   * `@civitai/app-sdk`'s `blocks/types.ts` mirrors. The SDK's inbound validator
   * does not know it yet, so a block reads it only after the SDK type is widened
   * in that repo — tracked separately; nothing here edits another repo.
   */
  modelSubstitutions?: Array<{
    requested: number;
    applied: number;
    reason: ModelSubstitutionReason;
  }>;
  /**
   * Generated FREE TEXT produced by a registered step whose `moderationPosture`
   * is `'textOutput'` — and which has PASSED an output moderation scan.
   *
   * 🔴 EVERY STRING HERE HAS BEEN SCANNED. That is a property of how the field
   * is produced, not a promise about who sets it. The single producer is
   * `attachModeratedStepTextOutputs` (`services/blocks/steps/moderation`), which
   * runs the scan and strips any incoming value of this field before merging its
   * own. Do NOT set it anywhere else; doing so would be publishing unscanned
   * model output, which is the one thing the `'textOutput'` posture exists to
   * prevent.
   *
   * 🔴 BE EXACT ABOUT WHAT ENFORCES THAT — AN EARLIER REVISION OF THIS COMMENT
   * WAS WRONG, AND IT IS RECORDED RATHER THAN QUIETLY REPLACED BECAUSE THIS IS
   * THE WIRE-CONTRACT DOC AN ENTRY AUTHOR AND THE `@civitai/app-sdk`
   * MIRROR-WRITER READ. It said `snapshotFromWorkflow` and `projectAppWorkflow`
   * "are pure and synchronous and read only `extractOutput`, which returns MEDIA
   * — neither can put prose in a snapshot at all". `StepOutputMedia.url` is a
   * bare `string`, never URL-validated, and it reaches `snapshot.imageUrls` /
   * `AppWorkflow.images[].url` without meeting the scan — so
   * `extractOutput: () => [{ url: theModelsReply, … }]` on a text entry WOULD
   * have published unscanned generated text with every gate green. Anyone
   * trusting the old sentence would conclude a media extractor on a text entry
   * is structurally harmless and propose relaxing registry clause 8-ii. It is
   * not harmless; 8-ii is load-bearing.
   *
   * WHAT ACTUALLY HOLDS IT (all three off the one `stepOutputShape` predicate,
   * and spelled out at `attachModeratedStepTextOutputs`): the TYPE
   * (`TextOutputSurface.extractOutput?: never`), the LOAD-time registry clause
   * 8-ii, and the READ path (both `workflow.service` extractors call
   * `extractOutput` only when `postureProducesMedia(...)`). The original
   * structural point does still stand on its own — a scan is an async network
   * call and both projections are pure and synchronous, so neither could perform
   * one — but it bounds only WHO CAN SCAN, never what a media extractor can
   * smuggle.
   *
   * WHERE IT APPEARS: `blocks.pollWorkflow` and `blocks.cancelWorkflow` — the
   * two procedures wrapped by `attachModeratedStepTextOutputs`, and therefore
   * the only two that can carry THIS FIELD.
   *
   * 🔴 THE EARLIER WORDING CALLED THEM "the two surfaces a block reads a
   * finished generation from", WHICH IS AN OVERCLAIM — corrected at the poll
   * itself for the same reason, and recorded here too. Three further procedures
   * read a finished workflow on a block's behalf, UNWRAPPED:
   * `blocks.queryAppWorkflows`, `blocks.cancelAppWorkflow` and
   * `blocks.publishGenerationOutputs` (note these are DIFFERENT procedures from
   * the similarly-named wrapped pair). What makes those three safe is stated at
   * each of them — `AppWorkflow` has no text field, and its `images` are
   * posture-gated — not here.
   *
   * NOT on the submit replies, and that is not an oversight: the step submit
   * passes no `wait`, so the reply is a freshly-queued workflow with no `output`
   * to publish. It is also not load-bearing — a submit reply is built by
   * `snapshotFromWorkflow`, which does not produce this field, so an
   * orchestrator that started answering submits with completed output would
   * degrade to "the block polls once more", never to "unscanned text ships".
   *
   * OMITTED entirely when there is no text, so every existing snapshot stays
   * byte-identical.
   *
   * 🔴 WIRE CONTRACT: additive on the type `@civitai/app-sdk`'s `blocks/types.ts`
   * mirrors, exactly like `modelSubstitutions` above. The SDK's inbound
   * validator does not know it yet, so a block reads it only once that type is
   * widened in the SDK repo — tracked separately; nothing here edits another repo.
   */
  textOutputs?: string[];
  /**
   * Set when a text-posture step produced nothing the block can be given, with a
   * user-facing sentence saying why. TWO distinct causes land here:
   *
   *   1. WITHHELD — text WAS produced and is being kept back: a content-policy
   *      hit, or a scanner error/timeout (the scan fails CLOSED).
   *   2. UNPUBLISHABLE — the step SUCCEEDED and the scan RELEASED, but the
   *      entry's extractors could publish none of what came back (e.g. a
   *      provider tool-call `id` outside the published charset). Nothing was
   *      moderated in this case, and the message says so explicitly.
   *
   * 🔴 AN EARLIER VERSION OF THIS DOC DESCRIBED ONLY CAUSE 1 — "generated text
   * WAS produced but is being withheld" — and both halves of that sentence are
   * FALSE on cause 2: no text was produced, and no policy or scanner event
   * occurred. This is the doc the `@civitai/app-sdk` mirror-writer and block
   * authors read, so a consumer branching on it was being told the wrong thing.
   * If a third cause is ever added, correct this list in the same change.
   *
   * `reason` is deliberately generic: it does not name the labels that
   * triggered. The triggering labels + scores go to the per-app trigger log
   * instead, which is where the actionable signal lives (an app whose outputs
   * trigger constantly is telling you about its system prompt).
   *
   * 🔴 THE TWO CAUSES ARE NOT MACHINE-SEPARABLE without matching on the string,
   * which is NOT a contract. A consumer needing to branch on the difference is
   * the trigger to add a discriminated reason code — not before.
   *
   * 🔴 CAUSE 2 IS GATED ON THE STEP'S OWN `succeeded` STATUS, so an in-flight or
   * cancelled generation does NOT set this field. A block polling a healthy
   * running workflow sees it absent, as it did before cause 2 existed.
   *
   * Independent of `textOutputs` rather than mutually exclusive: a workflow with
   * two text steps can release one and withhold the other, and both fields then
   * appear. Because of that pairing the `reason` is scoped to "a step in this
   * response", never to the response as a whole.
   */
  textOutputWithheld?: { reason: string };
  /**
   * Structured tool calls the model requested on a registered `'textOutput'`
   * step — and which have PASSED the same output moderation scan `textOutputs`
   * passes.
   *
   * 🔴 SAME SINGLE PRODUCER, SAME STRIPPING, SAME RULE.
   * `attachModeratedStepTextOutputs` is the only writer; it strips any incoming
   * value of this field before merging its own, and it attaches tool calls ONLY
   * onto a released verdict. Do NOT set it anywhere else.
   *
   * 🔴 WHY PUBLISHING THESE IS NOT A HOLE IN THE SCAN, since the objects
   * themselves are never handed to a scanner: the entry's `extractText` returns
   * every `arguments` string that appears here, so the released verdict was
   * computed over exactly that prose.
   *
   * 🔴 WHAT ENFORCES THAT, STATED AT ITS REAL STRENGTH. For `chat-completion`
   * the guarantee is STRUCTURAL — both extractors derive from one shared
   * predicate, so they cannot disagree. Registry clause 8b is a load-time
   * BACKSTOP against an entry re-splitting them, and it is only as wide as the
   * shapes its `canonicalOutputFor` sample exercises: a re-split on an axis the
   * sample does not cover would still pass. An earlier version of this line said
   * clause 8b "fails the build if an entry ever breaks that containment", which
   * is wider than the implementation — the same unscoped overclaim corrected in
   * `steps/moderation.ts` and `steps/chat-completion.step.ts`. Do not restate it.
   *
   * The tool NAME is not scanned and does
   * not need to be — it is pattern-bounded to `[A-Za-z0-9_-]` at both the param
   * schema and the extractor, so it cannot carry prose. Widening that charset
   * would make the name a free-text surface and is a moderation change, not a
   * validation one.
   *
   * WHERE IT APPEARS: `blocks.pollWorkflow` and `blocks.cancelWorkflow` — the
   * same two wrapped procedures as `textOutputs`, for the same reason.
   *
   * OMITTED entirely when there are none, so every existing snapshot stays
   * byte-identical.
   *
   * 🔴 WIRE CONTRACT: additive on the type `@civitai/app-sdk`'s `blocks/types.ts`
   * mirrors, exactly like `textOutputs` and `modelSubstitutions` above. The SDK's
   * inbound validator does not know it yet, so a block reads it only once that
   * type is widened in the SDK repo — tracked separately; nothing here edits
   * another repo.
   */
  toolCalls?: BlockStepToolCall[];
};
