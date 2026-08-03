import * as z from 'zod';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { REGISTERED_RECIPE_IDS } from '~/server/services/blocks/recipes';
import { REGISTERED_STEP_IDS } from '~/server/services/blocks/steps';
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

// App Blocks customComfy bridge (v1). Coarse fail-closed wire gate only:
//  - `recipe` MUST be a REGISTERED recipe id (derived from the recipe registry
//    keys) — an unregistered id is rejected at the union, before any translator
//    or orchestrator call.
//  - `params` is an opaque `Record<string, unknown>` here; the per-recipe
//    `.strict()` param schema (prompt/seed/engine/accountType bounds) is applied
//    in the translator (`buildCustomComfyWorkflowInput`), which is the single
//    place a recipe's real param contract lives.
//  - `.strict()` rejects any extra top-level field on the body.
export const blockCustomComfyBodySchema = z
  .object({
    kind: z.literal('customComfy'),
    recipe: z.enum(REGISTERED_RECIPE_IDS),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

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
export const blockWorkflowBodySchema = z.discriminatedUnion('kind', [
  blockTextToImageBodySchemaChecked,
  blockCustomComfyBodySchema,
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
   * is produced, not a promise about who sets it: `snapshotFromWorkflow` and
   * `projectAppWorkflow` are pure and synchronous and read only `extractOutput`,
   * which returns MEDIA — neither can put prose in a snapshot at all. The single
   * producer is `attachModeratedStepTextOutputs`
   * (`services/blocks/steps/moderation`), which runs the scan and strips any
   * incoming value of this field before merging its own. Do NOT set it anywhere
   * else; doing so would be publishing unscanned model output, which is the one
   * thing the `'textOutput'` posture exists to prevent.
   *
   * WHERE IT APPEARS: `blocks.pollWorkflow` and `blocks.cancelWorkflow` — the
   * two surfaces a block reads a finished generation from. NOT on the submit
   * replies, and that is not an oversight: the step submit passes no `wait`, so
   * the reply is a freshly-queued workflow with no `output` to publish. It is
   * also not load-bearing — a submit reply is built by `snapshotFromWorkflow`,
   * which cannot emit this field at all, so an orchestrator that started
   * answering submits with completed output would degrade to "the block polls
   * once more", never to "unscanned text ships".
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
   * Set when generated text WAS produced but is being withheld — a content-policy
   * hit, or a scanner error/timeout (the scan fails CLOSED).
   *
   * `reason` is a user-facing message, deliberately generic: it does not name the
   * labels that triggered. The triggering labels + scores go to the per-app
   * trigger log instead, which is where the actionable signal lives (an app whose
   * outputs trigger constantly is telling you about its system prompt).
   *
   * Independent of `textOutputs` rather than mutually exclusive: a workflow with
   * two text steps can release one and withhold the other, and both fields then
   * appear.
   */
  textOutputWithheld?: { reason: string };
};
