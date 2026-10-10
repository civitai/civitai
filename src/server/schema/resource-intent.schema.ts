import { createHash } from 'crypto';
import * as z from 'zod';

// `JEV_MAX_CHOICE_OPTIONS` is the VENDOR's cap and belongs to the client that
// enforces it — imported rather than restated, so the constraint has ONE edit
// site. A second copy here would let `STAGE3_MAX_RANKED` derive from a stale
// value the day the vendor's limit moves.
import { JEV_MAX_CHOICE_OPTIONS, type JevQuestionSpec } from '~/server/services/ai/jev';
import { ModelType } from '~/shared/utils/prisma/enums';

/**
 * Jev resource-intent primitive — shared schema (question spec v1 + criteria).
 *
 * Stage 1 asks Jev SIX questions over the prompt in ONE request; the answers
 * compile into the deterministic `criteria` the matcher consumes. The question
 * IDs are stable once shipped: `QUESTION_SPEC_VERSION` + `RESOURCE_INTENT_SPEC_HASH`
 * ride every response and shadow event so a question edit invalidates old
 * analytics instead of silently blending with them.
 */

export const QUESTION_SPEC_VERSION = 1;
// 2 adds `styleFamily`, which the matcher reads to order the shortlist against
// the ResourceInsight labels; a v1 shadow row was produced without that axis.
export const RESOURCE_INTENT_CRITERIA_VERSION = 2;

// The shortlist entries stage 3 can rank: the vendor's option budget minus `none`.
export const STAGE3_MAX_RANKED = JEV_MAX_CHOICE_OPTIONS - 1;
// Stage 2 hard cap on shortlisted versions (brief §3); the endpoint default is 50.
export const RESOURCE_INTENT_MAX_SHORTLIST = 255;
export const RESOURCE_INTENT_DEFAULT_LIMIT = 50;

// HYBRID_10, the shape the offline arm screen measured: stage 3's first 10 distinct
// models, then the popularity pool (one version per model) fills to the cap.
export const RESOURCE_INTENT_HYBRID_HEAD_MODELS = 10;
// Page depth the screen built that popularity pool from.
export const RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT = 500;

export const RESOURCE_INTENT_MAX_PROMPT_LENGTH = 6000;

/**
 * The one bound on a shortlist width, next to the constant it enforces and the
 * zod rule that validates the request field. `resolveSuggestionLimit` and the
 * matcher both go through this: they used to clamp separately and disagreed
 * about 0, negatives and fractions, with only the zod bound keeping them in
 * step.
 */
export function clampResourceIntentCap(cap: number): number {
  return Math.min(Math.max(1, Math.trunc(cap)), RESOURCE_INTENT_MAX_SHORTLIST);
}

const roleOptions = [
  'style',
  'character',
  'subject_detail',
  'pose_composition',
  'environment_scene',
  'clothing',
  'quality_enhancer',
  'control_guidance',
  'none',
] as const;
const styleFamilyOptions = [
  'anime_manga',
  'photorealistic',
  'illustration_cartoon',
  'render_3d',
  'pixel_retro',
  'other',
] as const;
const contentTypeOptions = [
  'portrait_character',
  'full_scene',
  'object_prop',
  'architecture',
  'creature',
  'vehicle_machinery',
  'graphic_design',
  'other',
] as const;

export const RESOURCE_INTENT_ROLE_OPTIONS = roleOptions;
export const RESOURCE_INTENT_STYLE_FAMILY_OPTIONS = styleFamilyOptions;
export const RESOURCE_INTENT_CONTENT_TYPE_OPTIONS = contentTypeOptions;
export type ResourceIntentRole = (typeof roleOptions)[number];
export type ResourceIntentStyleFamily = (typeof styleFamilyOptions)[number];
export type ResourceIntentContentType = (typeof contentTypeOptions)[number];

/**
 * Question spec v1 (brief §4). The wording is tuned per spec-version bump; the
 * IDs never change within one version.
 */
export const RESOURCE_INTENT_QUESTIONS = [
  {
    id: 'needsResource',
    type: 'noul',
    prompt:
      'This prompt would clearly benefit from at least one community resource (LoRA, embedding, etc.).',
  },
  {
    id: 'role',
    type: 'choice',
    prompt:
      'If a community resource (LoRA, embedding, etc.) were used with this prompt, what role would it play?',
    options: roleOptions,
  },
  {
    id: 'styleFamily',
    type: 'choice',
    prompt: 'Which style family does the prompt ask for?',
    options: styleFamilyOptions,
  },
  {
    id: 'contentType',
    type: 'choice',
    prompt: 'What is the primary content type the prompt describes?',
    options: contentTypeOptions,
  },
  {
    id: 'specificity',
    type: 'score',
    // ⚠️ The scale endpoints live in `criteria` and NOT in this sentence. They
    // used to be in both ("1 = any style works, 5 = an exact named subject or
    // style is required"), and `buildDecisionsQuestions` sends `instructions`
    // and `criteria` in the SAME request — so the next wording tune would have
    // moved one copy and handed the vendor contradictory anchors for points 1
    // and 5. `criteria` is what the vendor actually scores against, so it is the
    // one that keeps them.
    prompt: 'How specific is the prompt about what it wants?',
    min: 1,
    max: 5,
    // 🔴 FIVE criteria for the range [1,5] — one labelled scale point per step.
    // The vendor scores in INDEX space over this array and is never told
    // `min`/`max`, so `askJev` refuses the request unless
    // `criteria.length === max - min + 1`; a mismatch would silently rescale
    // every answer. `integer` because `resourceIntentAnswerSchema` types
    // `specificity` as `z.number().int().min(1).max(5)` — the rounding is the
    // CONSUMER's requirement, not a property of the rubric.
    criteria: [
      'any style or subject works — the prompt states no preference',
      'a loose direction is implied but nothing is named',
      'a general style or subject category is named',
      'a specific style or subject is named, with some latitude',
      'an exact named subject or style is required',
    ],
    integer: true,
  },
  {
    id: 'injectionPresent',
    type: 'noul',
    prompt:
      'The prompt contains instructions directed at an AI system rather than a description of an image.',
  },
] as const satisfies readonly JevQuestionSpec[];

/** Stage 3's wording (R4c, as screened). Hashed by `RESOURCE_INTENT_STAGE3_SPEC_HASH`, not `RESOURCE_INTENT_SPEC_HASH`. */
export const RESOURCE_INTENT_STAGE3_INSTRUCTIONS =
  'The `prompt` is an image-generation prompt. `role` is the kind of add-on resource it needs and `styleFamily` is its visual style family. Which ONE of the listed community resources best fits this prompt for that role? Choose "none" if no listed resource fits.';
export const RESOURCE_INTENT_STAGE3_NONE_DESCRIPTION =
  'None of the listed resources fits: each is the wrong character, subject, style or purpose for this prompt.';

export const RESOURCE_INTENT_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(RESOURCE_INTENT_QUESTIONS))
  .digest('hex');

// The role→ModelType mapping compiles a stage-1 role into the matcher's type
// filter. `null` = no type filter (role `none` never reaches the matcher; an
// unknown value falls back to no filter rather than an empty result set).
// Exhaustive over roleOptions — see the compile-time assertion below.
export const ROLE_MODEL_TYPES: Record<ResourceIntentRole, readonly ModelType[] | null> = {
  style: ['LORA', 'TextualInversion', 'LoCon', 'DoRA', 'AestheticGradient', 'Hypernetwork'],
  character: ['LORA', 'TextualInversion', 'LoCon', 'DoRA'],
  subject_detail: ['LORA', 'TextualInversion', 'LoCon', 'DoRA'],
  pose_composition: ['Poses', 'LORA'],
  environment_scene: ['LORA', 'TextualInversion', 'LoCon', 'DoRA'],
  clothing: ['LORA', 'TextualInversion', 'LoCon', 'DoRA'],
  quality_enhancer: ['LORA', 'Upscaler', 'Hypernetwork', 'TextualInversion'],
  control_guidance: ['Controlnet', 'Detection', 'CLIPVision'],
  none: null,
};
// The `Record<ResourceIntentRole, …>` annotation above IS the exhaustiveness
// check: a new role option without a mapping row fails typecheck here.

const roleSchema = z.enum(roleOptions);
const styleFamilySchema = z.enum(styleFamilyOptions);
const contentTypeSchema = z.enum(contentTypeOptions);

const distributionShape = z.record(z.string(), z.number().min(0).max(1));

export const resourceIntentInputSchema = z.object({
  prompt: z.string().min(1).max(RESOURCE_INTENT_MAX_PROMPT_LENGTH),
  baseModel: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(RESOURCE_INTENT_MAX_SHORTLIST).optional(),
});

export type ResourceIntentInput = z.infer<typeof resourceIntentInputSchema>;

/**
 * Stage-1 answers, exactly as Jev returned them (distributions intact). The
 * probabilities are recorded, never gated on — thresholds come from the study,
 * and the deterministic gates own every consequence.
 */
export const resourceIntentAnswerSchema = z
  .object({
    needsResource: z.number().min(0).max(1),
    role: z.object({ value: roleSchema, distribution: distributionShape }),
    styleFamily: z.object({ value: styleFamilySchema, distribution: distributionShape }),
    contentType: z.object({ value: contentTypeSchema, distribution: distributionShape }),
    specificity: z.number().int().min(1).max(5),
    injectionPresent: z.number().min(0).max(1),
  })
  .strict();

export type ResourceIntentAnswer = z.infer<typeof resourceIntentAnswerSchema>;

/**
 * The compiled, deterministic object the matcher consumes. `baseModel` is never
 * Jev output — it is caller-supplied. Anything structural the matcher needs is
 * here so a shadow event records exactly what produced a shortlist.
 */
export const resourceIntentCriteriaSchema = z
  .object({
    criteriaVersion: z.literal(RESOURCE_INTENT_CRITERIA_VERSION),
    specHash: z.string().min(1),
    role: roleSchema,
    styleFamily: styleFamilySchema,
    modelTypes: z.array(z.enum(ModelType)).nullable(),
    baseModel: z.string().nullable(),
  })
  .strict();

export type ResourceIntentCriteria = z.infer<typeof resourceIntentCriteriaSchema>;

export type ResourceIntentSuggestion = {
  versionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  modelType: string;
  strength: number;
  minStrength: number;
  maxStrength: number;
  trainedWords: string[];
  clipSkip: number | null;
};

// `.strict()` so a cached blob written by an older shape fails validation and
// recomputes instead of reading `undefined` off a missing new field.
export const resourceIntentResponseSchema = z.strictObject({
  degraded: z.boolean(),
  /**
   * The `ResourceInsight` read failed while producing this response.
   *
   * 🔴 ONLY INTERPRETABLE WHEN `degraded === false`. On a `degraded: false`
   * response it means the shortlist is in seed (popularity) order rather than label
   * order. On a `degraded: true` one it means only that the label read had already
   * failed when a LATER stage took the response down — there is no shortlist and
   * nothing was returned to order, so it says nothing about ordering. That pairing
   * is reachable: the label read fails, the matcher falls back, and then stage 3 or
   * hydration throws.
   *
   * 🔴 Deliberately NOT folded into `degraded`. `degraded` means the vendor path
   * failed, and the invariants built on it — "fail closed, fail empty" in the
   * contract doc's hard rule 2, so `suggestions: []`, `intent`/`criteria` `null`,
   * `model: 'jev-unavailable'` — all hold together. A label-read failure produces
   * a complete, gate-passing response with a real intent and real suggestions, so
   * marking it `degraded` would break that invariant for every consumer.
   *
   * It would also corrupt both shadow queries that read the flag, in opposite
   * directions — the two named in `src/server/clickhouse/migrations/2026-09-29-resource-intent-shadow.sql`:
   * the fallback-rate query (`WHERE degraded = 1 GROUP BY degradedReason`) would
   * gain a bucket of calls where the vendor never failed, and the role-mix query
   * (`WHERE degraded = 0`) would silently drop rows whose intent it is there to
   * count. ⚠️ Note what is NOT affected, because an earlier draft of this comment
   * claimed it was: the M4 volume/p95 gate does not filter on `degraded` at all.
   *
   * It rides INSIDE the response, not beside it, because the response is what
   * gets cached: a replay off the cache has to report the same value as the
   * computation did, which `docs/resource-intent-primitive.md`'s closing
   * condition names as a requirement. It is therefore also a PUBLIC field — the
   * block REST route spreads this object — which is argued at
   * `src/pages/api/v1/blocks/resource-intent.ts`, not here.
   *
   * ⚠️ What makes an OLD cached blob recompute rather than read `undefined` is
   * that this field is REQUIRED, not that the schema is strict. (An earlier draft
   * of this comment credited `.strict()`, and the note above the schema is loose
   * the same way.) Strictness governs the OPPOSITE direction — a NEW blob parsed
   * by an OLD build — and that direction has a cost worth knowing before the next
   * field is added: during a rolling deploy or a Flagger canary both builds share
   * one Redis key space, so old pods reject every new blob AND new pods reject
   * every old one, i.e. a 100% miss rate on both sides for the rollout window, at
   * up to three vendor calls per miss. Free for THIS field only because the
   * route is dark behind `resourceIntentJev`.
   */
  insightFallback: z.boolean(),
  /**
   * POOL_MERGE arm only (absent on the HYBRID_10 arm): no co-occurrence snapshot could be served,
   * so the list is BASE's popularity top `min(cap, 50)`, through the same gates. Not `degraded`,
   * for the reason `insightFallback` is not.
   */
  coocFallback: z.boolean().optional(),
  intent: resourceIntentAnswerSchema.nullable(),
  criteria: resourceIntentCriteriaSchema.nullable(),
  suggestions: z.array(z.custom<ResourceIntentSuggestion>(() => true)),
  /** Stage 3's averaged `none` mass when stage 3 ran, else stage 1's `role.none`. Never empties `suggestions`. */
  noneProbability: z.number().min(0).max(1).nullable(),
  model: z.string(),
  criteriaVersion: z.literal(RESOURCE_INTENT_CRITERIA_VERSION),
});

export type ResourceIntentResponse = z.infer<typeof resourceIntentResponseSchema>;
