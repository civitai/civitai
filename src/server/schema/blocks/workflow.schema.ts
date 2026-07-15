import * as z from 'zod';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

// The spendable buzz account types a viewer may pick for a (money) page block.
// Reuse the authoritative `buzzSpendTypes` (blue/green/yellow — `red` is
// disabled and filtered out) rather than a fresh literal so this stays in sync
// with the buzz-constants source of truth. The domain-maturity policy still
// CLAMPS which of these is actually spendable per-request in blocks.router
// (SFW → blue/green, mature → blue/yellow) — this enum only bounds the wire
// surface; it never widens the allowed set.
const blockAccountTypeSchema = z.enum(buzzSpendTypes as [BuzzSpendType, ...BuzzSpendType[]]);

// `textToImage` is the block-supported kind. It now covers the whole IMAGE
// workflow class (App Blocks IMAGE bridge, Phase-2a): a bare body maps to a
// `txt2img` graph workflow, and a body carrying a bounded `sourceImage` maps to
// `img2img` — see buildImageWorkflowInput / BLOCK_IMAGE_WORKFLOW_TYPES in
// workflow.service. A later phase adds a NON-image media class (video/audio/3D)
// as a NEW discriminated-union `kind` here, which must also (a) extend the
// discriminator in blocks.router workflow procedures, (b) be exposed by
// @civitai/app-sdk's useBuzzWorkflow contract.
//
// Caps are intentionally tighter than the platform-wide generateImageSchema —
// blocks run in untrusted iframes and the token issuer caps per-call buzz at
// BUZZ_BUDGET_CAP=1000, so wide-open quantity/dimensions wouldn't be honored
// anyway. Trim the surface area at the boundary instead of relying on
// downstream gates.

const PROMPT_MAX = 1500;
const NEG_PROMPT_MAX = 1500;
const DIM_MIN = 64;
const DIM_MAX = 2048;
const STEPS_MAX = 50;
const QUANTITY_MAX = 4;
const CLIP_SKIP_MAX = 12;

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
// It is bounded to a Civitai-controlled host. An uploaded image resolves to an
// `https://orchestration…civitai.com` URL, so this same bound covers the
// "uploaded image" case WITHOUT widening to attacker-controlled origins.
//
// This is validated by parsed URL HOSTNAME (not a substring match), which is
// intentionally tighter than the platform's server `sourceImageSchema`
// (`.includes('image.civitai.com')`) — a substring check would accept
// `https://evil.example/?x=image.civitai.com`; a hostname check rejects it and
// also rejects non-https, userinfo, and host-confusion tricks. Kept LOCAL
// (rather than importing the server orchestrator schema) so this module stays
// client-safe — it is `import type`'d by a client component (failureSnapshot).
const CIVITAI_IMAGE_HOSTS = ['civitai.com', 'civitai.red', 'civitai.green'] as const;
function isCivitaiHostedImageUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return CIVITAI_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const blockSourceImageSchema = z.object({
  url: z
    .string()
    .max(2048)
    .refine(isCivitaiHostedImageUrl, 'source image must be a Civitai-hosted https image URL'),
  // Dimension hints for the graph's denoise/aspect derivation. Bounded to the
  // same block caps as params so an iframe can't send absurd dimensions.
  width: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX),
  height: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX),
});

const blockTextToImageBodySchema = z.object({
  kind: z.literal('textToImage'),
  modelId: z.number().int().positive(),
  modelVersionId: z.number().int().positive(),
  // Optional LoRA stack (Increment 1, LoRA-only v1). Each entry resolves to a
  // LoRA-type model version that the server entitlement-gates per-resource and
  // base-model-family-matches against the checkpoint before any spend. Capped
  // at MAX_ADDITIONAL_RESOURCES for the iframe posture above.
  additionalResources: z.array(blockAdditionalResourceSchema).max(MAX_ADDITIONAL_RESOURCES).optional(),
  // Optional img2img init/source image (App Blocks IMAGE bridge, Phase-2a).
  // When present, the block bridge emits an `img2img` graph workflow (SD-family
  // "Image Variations") instead of `txt2img`; when absent, behavior is
  // byte-identical to before (txt2img). Bounded to a Civitai-hosted image (see
  // blockSourceImageSchema) — never an arbitrary remote URL.
  //
  // Two hard scope limits are enforced downstream (NOT at the wire schema, which
  // only bounds shape): (1) blocks.router rejects `sourceImage` on a MODEL-bound
  // token — img2img is PAGE-only in 2a, mirroring `additionalResources`; (2)
  // buildImageWorkflowInput rejects a non-SD-family checkpoint fail-closed —
  // plain `img2img` is SD-family-only in the graph, and edit-capable ecosystems
  // (Flux Kontext, Qwen → `img2img:edit`) are a Phase-2b follow-up.
  sourceImage: blockSourceImageSchema.optional(),
  // Optional viewer-picked buzz account to spend (money page blocks). Absent →
  // unchanged Auto behavior (domain-allowed currencies drained blue-first). When
  // present, blocks.router moves it to the FRONT of the domain-allowed currency
  // order (preferred-first, then fall back) and REJECTS it if it's outside the
  // domain-allowed set — the maturity policy is never widened here. See
  // `resolveBlockCurrenciesForAccount`.
  accountType: blockAccountTypeSchema.optional(),
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

export type BlockWorkflowBody = z.infer<typeof blockWorkflowBodySchema>;
export const blockWorkflowBodySchema = z.discriminatedUnion('kind', [blockTextToImageBodySchema]);

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
};
