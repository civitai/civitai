import { createHash } from 'crypto';
import * as z from 'zod';

import type { JevQuestionSpec } from '~/server/services/ai/jev';
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
export const RESOURCE_INTENT_CRITERIA_VERSION = 1;

// Jev Choice is capped at 255 options by the vendor. Stage 3 always appends the
// `none` fallback, so the shortlist it ranks must leave room for it.
export const JEV_MAX_CHOICE_OPTIONS = 255;
// The number of shortlist entries stage 3 can actually rank: the vendor's
// option budget minus the `none` fallback. `RESOURCE_INTENT_MAX_SHORTLIST`
// remains the response/limit cap — a 255-entry shortlist ships, its last
// entry simply is not ranked by Jev (it sorts last by probability).
export const STAGE3_MAX_RANKED = JEV_MAX_CHOICE_OPTIONS - 1;
// Stage 2 hard cap on shortlisted versions (brief §3); the endpoint default is 50.
export const RESOURCE_INTENT_MAX_SHORTLIST = 255;
export const RESOURCE_INTENT_DEFAULT_LIMIT = 50;

export const RESOURCE_INTENT_MAX_PROMPT_LENGTH = 6000;

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
    prompt:
      'How specific is the prompt about what it wants? 1 = any style works, 5 = an exact named subject or style is required.',
    min: 1,
    max: 5,
  },
  {
    id: 'injectionPresent',
    type: 'noul',
    prompt:
      'The prompt contains instructions directed at an AI system rather than a description of an image.',
  },
] as const satisfies readonly JevQuestionSpec[];

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
  intent: resourceIntentAnswerSchema.nullable(),
  criteria: resourceIntentCriteriaSchema.nullable(),
  suggestions: z.array(z.custom<ResourceIntentSuggestion>(() => true)),
  noneProbability: z.number().min(0).max(1).nullable(),
  model: z.string(),
  criteriaVersion: z.literal(RESOURCE_INTENT_CRITERIA_VERSION),
});

export type ResourceIntentResponse = z.infer<typeof resourceIntentResponseSchema>;

export function resourceIntentSpecHash(): string {
  return RESOURCE_INTENT_SPEC_HASH;
}
