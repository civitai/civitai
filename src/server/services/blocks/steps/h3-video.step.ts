import * as z from 'zod';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import { mediaFromBlobs } from './output';
import type { StepOutputMedia } from './output';
import type { BlockStep, OrchestratorStepTemplate } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// `videoGen` on MiniMax H3, through the local Comfy backend.
//
// WHY A REGISTRY ENTRY RATHER THAN THE PASS-THROUGH ARM — and this is the whole
// reason the entry exists, not a preference:
//
// A pass-through body declares `maxBuzz`, and the host stamps
// `stepTimeoutSeconds = maxBuzz`. `maxBuzz` is capped at 250, so a pass-through
// step is killed after at most 250 seconds of wall clock. A six-second H3 clip
// does not fit: measured over ten runs (`startedAt` → `completedAt`, queue time
// excluded), 321.2 321.2 324.7 326.6 326.9 331.1 334.4 339.3 351.5 357.2 —
// median 327.6s, and the FASTEST exceeds the cap by 71 seconds. Ten out of ten.
// There is no `maxBuzz` value that rescues it, because the value that would buy
// the time is above the ceiling.
//
// `prepaidFixed` resolves `stepTimeoutSeconds: null`, and
// `buildStepOrchestratorStep` then omits the `timeout` key entirely, so the
// step inherits the orchestrator's own default for its `$type` — the same
// condition under which those ten runs succeeded.
//
// THE FOUR BARS:
//
//  1. A GENUINE STANDALONE `$type`. `VideoGenStep` / `VideoGenStepTemplate` are
//     first-class in `@civitai/client`, exposed at
//     `/v2/consumer/recipes/videoGen`, and `videoGen` is not in
//     `NATIVELY_EXTRACTED_STEP_TYPES`, so this entry's own extractor is the one
//     that runs.
//
//  2. DETERMINISTIC COST. Priced per output second by Civitai's own rate card,
//     and resolution does not enter it — which is why `width`/`height` below are
//     server-fixed rather than client-settable. See the measurements on
//     `H3_BUZZ_PER_SECOND`.
//
//  3. A FREE-TEXT INPUT, AND IT IS AUDITED. The prompt is viewer-authored and
//     reaches a video model, so the posture is `promptAudit` and `auditableText`
//     hands `auditPromptServer` the same field `textToImage` does. The output is
//     a video blob, not text, so there is no output-phase text surface.
//
//  4. NO AIR ENTITLEMENT SURFACE. `ComfyMiniMaxH3VideoGenInput` accepts `loras`
//     and `diffusionModel`; this entry exposes NEITHER, so the built step
//     carries no AIR URN and there is nothing for the entitlement belt to gate.
//     Enforced at load by the clause that deep-scans the built step.
//
// ✅ THE PRICE IS MEASURED. Free `whatif:true` submits of this exact step shape
// against the live orchestrator on 2026-09-21 returned
// `cost.total = 210` for `duration: 6` (`{base:210, factors:{base:210},
// fixed:{loras:0}, tips:{civitai:0,creators:0}}`) and `140` for `duration: 4`.
// That is 35 Buzz per output second, linear, which is what the per-duration
// variants below encode.
//
// 🔴 A MEASURED PRICE IS NOT A SELF-ENFORCING ONE. The submit path runs its own
// `whatif` and reserves `max(declared, quoted)`, so a rate-card move is caught
// at submit rather than by someone reading a counter later. Do not treat the
// constant as the ceiling. The exposure here is smaller than
// `chat-completion`'s — this is GPU time Civitai prices itself, not a
// third-party per-token rate that moves underneath us — but it is not zero.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Buzz per second of output video on `minimax-h3-comfy`.
 *
 * The hosted `minimax-h3` engine is 170/s for the same model; this entry
 * deliberately exposes only the Comfy engine, which is ~5x cheaper and prices
 * resolution flat.
 */
export const H3_BUZZ_PER_SECOND = 35;

/**
 * The durations a block may ask for, as the variant set.
 *
 * Bounded to two rather than the engine's full 4–15s range because the variant
 * set IS the price table: every entry here is a price a reviewer has seen
 * measured. Widening is additive — add the second, add the variant, measure it.
 *
 * 🔴 THE CEILING IS NOT ARBITRARY. Longer clips take proportionally longer to
 * generate, and the whole point of this entry is that the job outlives a
 * pass-through timeout. A duration whose wall clock exceeds the orchestrator's
 * own default step timeout would fail the same way one layer up, so do not add
 * one without measuring the RUN TIME as well as the price.
 */
export const H3_DURATIONS = [4, 6] as const;
export type H3Duration = (typeof H3_DURATIONS)[number];

/**
 * Fixed output size, server-side.
 *
 * The engine prices resolution flat, so letting a block choose would add a
 * parameter that changes nothing about the cost and everything about what the
 * price table means. 1344x768 is the largest size the Comfy engine accepts.
 */
const OUTPUT_WIDTH = 1344;
const OUTPUT_HEIGHT = 768;

/** Matches the prompt bound the `textToImage` block body enforces. */
const PROMPT_MAX = 1500;

const h3VideoParamsSchema = z
  .object({
    /**
     * The viewer-authored prompt, audited by the `promptAudit` posture before
     * anything is reserved or submitted.
     */
    prompt: z.string().min(1).max(PROMPT_MAX),
    /**
     * The still the clip starts from.
     *
     * Bounded to a Civitai-controlled host by the SHARED schema — the same one
     * the `convertImage` entry and the `textToImage` body use. That bound is
     * what stops a block pointing the worker at an arbitrary URL; note it
     * accepts the `orchestration*.civitai.com` blob host, which is where a
     * previous step's output and an uploaded image both live.
     */
    firstFrame: civitaiHostedImageUrlSchema,
    /**
     * Optional still the clip must END on. A whip pan has to land somewhere
     * specific or the model invents whatever it likes at the cut.
     */
    lastFrame: civitaiHostedImageUrlSchema.optional(),
    duration: z.union([z.literal(4), z.literal(6)]),
  })
  .strict();

export type H3VideoStepParams = z.infer<typeof h3VideoParamsSchema>;

/**
 * The shape `extractOutput` reads, anchored to the generated contract in
 * `type-contract.ts` rather than to this author's reading of it.
 *
 * `VideoGenOutput` also declares `additionalVideos` (populated only by engines
 * that batch several videos per job — H3 is not one) and `draftCache`. Only the
 * primary slot is published: a draft-cache blob is an intermediate, not a
 * result, and handing it to a block as if it were the video is the kind of
 * silent substitution nobody notices until the finished cut is wrong.
 */
export type VideoGenOutputStepLike = {
  output?: {
    video?: {
      url?: string | null;
      available?: boolean;
      width?: number | null;
      height?: number | null;
      nsfwLevel?: string | null;
    } | null;
  } | null;
};

export const h3VideoStep = {
  id: 'h3-video',
  orchestratorType: 'videoGen',
  billingMode: 'prepaidFixed',
  moderationPosture: 'promptAudit',
  resourcePolicy: { kind: 'none' },
  paramSchema: h3VideoParamsSchema,
  // Durations AS variants: the allowlist, the price key and the audit row's
  // `detail.variant` in one declaration.
  variants: H3_DURATIONS.map((d) => String(d)),
  resolveVariant: (params: H3VideoStepParams): string => String(params.duration),
  canonicalParamsFor: (variant: string): H3VideoStepParams => ({
    prompt: 'ping',
    firstFrame: 'https://image.civitai.com/probe.png',
    // Checked, not assumed: the load-time clause safeParses these params
    // against the schema above, so a variant that is not a real duration fails
    // at registry LOAD rather than producing an unparseable canonical object.
    duration: Number(variant) as H3Duration,
  }),
  priceForVariant: (variant: string): number => Number(variant) * H3_BUZZ_PER_SECOND,
  estimateBuzz: (params: H3VideoStepParams): number => params.duration * H3_BUZZ_PER_SECOND,
  auditableText: (params: H3VideoStepParams) => ({ prompt: params.prompt }),
  buildStep: (params: H3VideoStepParams): OrchestratorStepTemplate => ({
    $type: 'videoGen',
    input: {
      engine: 'minimax-h3-comfy',
      operation: 'imageToVideo',
      prompt: params.prompt,
      firstFrame: params.firstFrame,
      ...(params.lastFrame ? { lastFrame: params.lastFrame } : {}),
      duration: params.duration,
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
    },
  }),
  extractOutput: (step: unknown): StepOutputMedia[] =>
    mediaFromBlobs((step as VideoGenOutputStepLike | null | undefined)?.output?.video),
  /**
   * A canonical COMPLETED step, for the load-time extraction probe.
   *
   * 🔴 Copied from a real captured orchestrator response (workflow
   * `1-20260921033602105`, 2026-09-21), not invented to match `extractOutput`.
   * A sample written from the extractor would assert only that the code agrees
   * with itself. Field names, nesting and the `available` flag are the observed
   * ones; the url signature and the prompt are shortened.
   *
   * Two observed details deliberately kept rather than tidied, because both are
   * things a hand-written sample would have omitted and both are real: the
   * sibling `output.progress` next to `video`, and a `duration` of 6.583 where
   * the input asked for 6.
   */
  canonicalOutputFor: (): unknown => ({
    $type: 'videoGen',
    name: 'block-step',
    status: 'succeeded',
    output: {
      progress: 1,
      video: {
        width: 1344,
        height: 768,
        duration: 6.583,
        id: 'KHAYZ6BS0VY8QR8Z7Z8ZPXDDA0.mp4',
        available: true,
        url: 'https://orchestration-new.civitai.com/v2/consumer/blobs/KHAYZ6BS0VY8QR8Z7Z8ZPXDDA0.mp4?sig=probe',
        nsfwLevel: 'pg',
      },
    },
  }),
} satisfies BlockStep<H3VideoStepParams>;
