import * as z from 'zod';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import type { BlockStep, OrchestratorStepTemplate } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// Tranche 1, entry 1 — `convertImage`.
//
// WHY THIS ONE QUALIFIES (the four bars, checked against the orchestrator's own
// generated types in `@civitai/client`):
//
//  1. A GENUINE STANDALONE `$type`. `ConvertImageStep` / `ConvertImageStepTemplate`
//     with `$type: 'convertImage'` are first-class in the generated client, and
//     the orchestrator exposes it as a standalone consumer recipe at
//     `/v2/consumer/recipes/convertImage`. It is not an internal helper (unlike
//     `preprocessImage`, which `controlnets.helper.ts` emits in front of a
//     generation) and not a Comfy workflow feature. Civitai already submits it
//     server-side as a single-step workflow (`product-badge.service.ts`
//     `resizeBadgeImage`), so the shape is proven in production.
//
//  2. DETERMINISTIC COST. Format conversion + a resize transform is a fixed CPU
//     operation on a bounded input. There is no GPU model, no sampler, no
//     variable step count and no wall-clock dependence, so the cost is knowable
//     before execution → `prepaidFixed`.
//
//  3. NO NEW MODERATION SURFACE. Input is an image URL bounded to a
//     Civitai-controlled host; output is an image blob. There is no free-text
//     input to audit and no free-text output to moderate → posture `'none'`.
//
//  4. NO CHECKPOINT/LoRA ENTITLEMENT ENTANGLEMENT. The step references no AIR
//     resource of any kind, so there is nothing for the entitlement belt to gate
//     and no way to reach a gated / early-access / Private model version through
//     it.
//
// 🔴 THE ONE THING THAT IS NOT LOCALLY VERIFIABLE is the orchestrator's ACTUAL
// price for this step. It could not be measured from this environment (it needs
// a real orchestrator token and a live `whatif` call). `PRICE_BUZZ` below is
// therefore a DECLARED CEILING chosen conservatively, and the router treats a
// realized cost ABOVE it as a cap-accounting shortfall it must top up and
// report — see `civitai_app_block_step_price_divergence_total` in
// `blocks.router.ts`. That instrumentation exists precisely because this number
// is the one input to the money path that was not verified before shipping.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The declared exact price, in Buzz.
 *
 * Reserved against the per-user daily cap, the per-app aggregate cap and (when
 * present) the dev-session cap BEFORE submit, and gated against the block
 * token's per-call `buzzBudget`. Must be a positive integer — enforced at
 * registry load (`assertStepInvariants`).
 *
 * Set to 1: this is a CPU-only transform, so the honest expectation is that the
 * orchestrator charges at or near zero. A price of 1 is the smallest value the
 * invariant permits and errs in the SAFE direction (over-reserving against an
 * abuse cap is stricter; under-reserving is a hole). It is not a claim about
 * the orchestrator's rate card — see the header.
 */
export const CONVERT_IMAGE_PRICE_BUZZ = 1;

/** The only variant in v1. Kept explicit so pricing can diverge per output format later. */
const DEFAULT_VARIANT = 'default';

// Bounds on the resize transform. Deliberately the SAME image-dimension bounds
// the `textToImage` block body enforces (`DIM_MIN`/`DIM_MAX` in
// workflow.schema) — a block cannot ask for a larger canvas through the step
// bridge than it can through the generation bridge. Restated as local constants
// rather than imported, because importing `workflow.schema` from the registry
// would be a cycle (that module imports the registry for its wire enum).
const TARGET_WIDTH_MIN = 64;
const TARGET_WIDTH_MAX = 2048;
const QUALITY_MIN = 1;
const QUALITY_MAX = 100;

/**
 * The bounded transform surface.
 *
 * v1 exposes ONLY `resize`. The orchestrator's `ImageTransform` base is an open
 * `{ type: string }` with several concrete subtypes (`resize`, `blur` with
 * region masks, …); forwarding an open discriminator from an untrusted iframe
 * would put the whole transform surface — including region-masked blur — on the
 * public wire contract sight-unseen. Widening later is additive; narrowing is
 * breaking, so start narrow.
 */
const resizeTransformSchema = z
  .object({
    type: z.literal('resize'),
    targetWidth: z.number().int().min(TARGET_WIDTH_MIN).max(TARGET_WIDTH_MAX),
  })
  .strict();

const outputFormatSchema = z
  .object({
    format: z.enum(['png', 'jpeg', 'webp']),
    /** Only meaningful for jpeg/webp; the orchestrator ignores it for png. */
    quality: z.number().int().min(QUALITY_MIN).max(QUALITY_MAX).optional(),
    /** webp only; ignored elsewhere. */
    lossless: z.boolean().optional(),
    /**
     * Defaults to TRUE here, unlike the orchestrator's own default of false.
     * A block converts images on behalf of an end user, and silently carrying
     * that user's EXIF (which routinely includes GPS and device identity)
     * through an app-controlled pipeline is a privacy leak the app author never
     * has to think about. Opting out is explicit.
     */
    hideMetadata: z.boolean().default(true),
  })
  .strict();

const convertImageParamsSchema = z
  .object({
    /**
     * 🔴 Bounded to a Civitai-hosted https URL — never an arbitrary remote URL.
     * This param comes from an untrusted iframe and the orchestrator FETCHES it,
     * so an open URL here is a server-side-request-forgery primitive. Reuses the
     * exact predicate the `textToImage` bridge's `sourceImage` uses (one rule,
     * one place: `~/server/schema/blocks/civitai-image-url`).
     */
    image: civitaiHostedImageUrlSchema,
    transforms: z.array(resizeTransformSchema).max(4).optional(),
    output: outputFormatSchema,
  })
  .strict();

export type ConvertImageStepParams = z.infer<typeof convertImageParamsSchema>;

export const convertImageStep = {
  id: 'convert-image',
  orchestratorType: 'convertImage',
  billingMode: 'prepaidFixed',
  moderationPosture: 'none',
  paramSchema: convertImageParamsSchema,
  variants: [DEFAULT_VARIANT],
  resolveVariant: () => DEFAULT_VARIANT,
  canonicalParamsFor: (): ConvertImageStepParams => ({
    image: 'https://image.civitai.com/probe.png',
    output: { format: 'webp', hideMetadata: true },
  }),
  priceForVariant: () => CONVERT_IMAGE_PRICE_BUZZ,
  estimateBuzz: () => CONVERT_IMAGE_PRICE_BUZZ,
  buildStep: (params: ConvertImageStepParams): OrchestratorStepTemplate => ({
    $type: 'convertImage',
    input: {
      image: params.image,
      ...(params.transforms ? { transforms: params.transforms } : {}),
      output: params.output,
    },
  }),
} satisfies BlockStep<ConvertImageStepParams>;
