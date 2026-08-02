import * as z from 'zod';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import { mediaFromBlobs } from './output';
import type { StepOutputMedia } from './output';
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
// ✅ THE PRICE IS NOW MEASURED, NOT DECLARED. A real `whatif:true` submit of
// this exact step shape was run against the live orchestrator from the PR
// preview environment on 2026-08-02, and a real (non-whatif) submit was run and
// polled to `succeeded`. Both returned `cost.total = 1`
// (`cost: {base:1, factors:{base:1}, fixed:{}, tips:{...}, total:1}`), and the
// per-job cost was likewise `1`. `PRICE_BUZZ = 1` therefore matches the
// orchestrator's own quote rather than being a conservative guess.
//
// 🔴 That measurement does NOT make the price self-enforcing, so the submit path
// no longer trusts it as the ceiling: it runs its own `whatif` before the
// per-call `buzzBudget` gate and reserves `max(declared, quoted)`. See the
// ORCHESTRATOR QUOTE section in `blocks.router.ts`. A single measurement is one
// point on a rate card that can change; the gate must not depend on it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The declared exact price, in Buzz.
 *
 * Reserved against the per-user daily cap, the per-app aggregate cap and (when
 * present) the dev-session cap BEFORE submit. Must be a positive integer —
 * enforced at registry load (`assertStepInvariants`).
 *
 * Set to 1 because that is what the orchestrator actually quoted for this step
 * shape (see the header for the measurement). It is also the value `estimateBuzz`
 * shows the block, and the registry's load-time invariant forces those two to
 * agree.
 *
 * 🔴 It is NOT the enforced ceiling. The per-call `buzzBudget` gate runs against
 * the orchestrator's live `whatif` quote, so a rate-card change is caught at
 * submit rather than by a human reading a counter later.
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

/**
 * The orchestrator's completed-step shape for `convertImage`.
 *
 * 🔴 SINGULAR `blob`, not `images` and not `blobs` — `ConvertImageOutput` in
 * `@civitai/client` is `{ blob?: ImageBlob }`, and `product-badge.service.ts`
 * reads `step.output.blob.url`. This is the whole reason output extraction had
 * to become a registry field: both `workflow.service` extractors were blind to
 * this step in TWO independent ways (the `$type` was not in their allowlist, and
 * the key is not one they read), so a paid-for conversion could never be
 * retrieved.
 *
 * Shape confirmed against a REAL orchestrator response (2026-08-02, live
 * `convertImage` workflow polled to `succeeded`): `step.output` had exactly the
 * key `blob`, with `available` transitioning false→true, plus `url`, `width`
 * (797) and `height` (1024). No `images` key and no `blobs` key were present.
 *
 * 🔴 EXPORTED SO IT CAN BE ANCHORED TO THE GENERATED CONTRACT. `extractOutput`
 * takes `unknown` and reaches this shape through a cast, so nothing at the call
 * site links it to the orchestrator's own types. `type-contract.ts` asserts that
 * a real `ConvertImageStep` from `@civitai/client` satisfies it and that every
 * key it reads exists on the generated `ConvertImageOutput` / `ImageBlob` — which
 * moves the anchor for THIS entry off the author and onto a type Civitai does not
 * hand-write.
 */
export type ConvertImageOutputStepLike = {
  output?: {
    blob?: {
      url?: string | null;
      available?: boolean;
      width?: number | null;
      height?: number | null;
      nsfwLevel?: string | null;
    } | null;
  } | null;
};

export const convertImageStep = {
  id: 'convert-image',
  orchestratorType: 'convertImage',
  billingMode: 'prepaidFixed',
  moderationPosture: 'none',
  // References no AIR resource of any kind — no checkpoint, no LoRA, no upscale
  // model. Nothing for the entitlement belt to gate. ENFORCED at registry load,
  // not just declared: clause 7 deep-scans the built step for an AIR URN.
  resourcePolicy: { kind: 'none' },
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
  /**
   * The SINGULAR `blob` this step type returns → the shared media shape. The
   * availability + non-empty-url filter comes from `mediaFromBlobs`, so it is
   * the same rule the other extraction paths apply, in one place.
   */
  extractOutput: (step: unknown): StepOutputMedia[] =>
    mediaFromBlobs((step as ConvertImageOutputStepLike | null | undefined)?.output?.blob),
  /**
   * A canonical COMPLETED step, for the load-time extraction probe.
   *
   * 🔴 Copied from a real captured orchestrator response (2026-08-02), not
   * invented to match `extractOutput`. A sample written from the extractor would
   * make the probe assert only that the code agrees with itself — the exact
   * both-wrong-blind failure where the fake encodes the same wrong shape as the
   * code under test. Field names, nesting and the `available` flag here are the
   * observed ones; only the url/signature are shortened.
   */
  canonicalOutputFor: (): unknown => ({
    $type: 'convertImage',
    name: 'block-step',
    status: 'succeeded',
    output: {
      blob: {
        id: 'W9E3ZK1G1RJSH6S88HT3GW5ZW0.webp',
        url: 'https://orchestration-new.civitai.com/v2/consumer/blobs/W9E3ZK1G1RJSH6S88HT3GW5ZW0.webp?sig=probe',
        available: true,
        width: 797,
        height: 1024,
      },
    },
  }),
} satisfies BlockStep<ConvertImageStepParams>;
