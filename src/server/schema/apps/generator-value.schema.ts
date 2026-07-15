import * as z from 'zod';

/**
 * Structured "published generator" value schema (Custom Generators, Phase-2a
 * PR-B). This is the JSON shape stored in an App Blocks `shared_kv` row when a
 * user PUBLISHES a generator (cross-user, mod-visible), distinct from the plain
 * text `{ title, body }` shared value.
 *
 * The value is UNTRUSTED (it arrives from an iframe block over a block token),
 * so EVERY field is bounded here — array sizes, string lengths, numeric ranges.
 * The free-text fields (`name`, `description`, each button's `promptTemplate`)
 * additionally run the shared content-safety belt at publish time
 * (assertGeneratorTextSafe), and every pinned resource (checkpoint + each LoRA
 * versionId across all buttons) is validated fail-closed through the platform's
 * canonical generation-entitlement gate (resolveCanGenerateForVersions).
 *
 * v1 is image-oriented but schema-forward: `workflowType` is an enum that can
 * grow, and `params` mirrors the block workflow param caps
 * (schema/blocks/workflow.schema.ts) so a published generator and a live block
 * submission share the same cost profile.
 */

// ── Text caps ─────────────────────────────────────────────────────────────────
// Kept under the shared-storage belt ceilings (SHARED_TITLE_MAX=200,
// SHARED_BODY_MAX=4096) so the reused content-safety belt never size-rejects a
// field the Zod schema already accepted.
export const GEN_NAME_MAX = 100;
export const GEN_DESCRIPTION_MAX = 2000;
export const GEN_BUTTON_LABEL_MAX = 60;
// Mirrors PROMPT_MAX / NEG_PROMPT_MAX in schema/blocks/workflow.schema.ts.
export const GEN_PROMPT_TEMPLATE_MAX = 1500;
export const GEN_NEG_PROMPT_MAX = 1500;

// ── Structural caps ─────────────────────────────────────────────────────────
export const GEN_MAX_BUTTONS = 8;
// A generator button pins the SAME LoRA fan-out the block Page-LoRA path caps at
// (MAX_ADDITIONAL_RESOURCES = 5) and the SAME strength range ([-1, 2]).
export const GEN_MAX_LORAS_PER_BUTTON = 5;
export const GEN_LORA_WEIGHT_MIN = -1;
export const GEN_LORA_WEIGHT_MAX = 2;

// ── Param caps (mirror schema/blocks/workflow.schema.ts) ────────────────────
const DIM_MIN = 64;
const DIM_MAX = 2048;
const STEPS_MAX = 50;
const QUANTITY_MAX = 4;
const CLIP_SKIP_MAX = 12;

// v1 workflow kinds. `textToImage` is the only one PR-A's generation bridge
// builds today; `imageToImage` is reserved (schema-forward) and gated by
// `exposedInputs.image` on the render/bridge side — this PR only STORES it.
export const GENERATOR_WORKFLOW_TYPES = ['textToImage', 'imageToImage'] as const;
export type GeneratorWorkflowType = (typeof GENERATOR_WORKFLOW_TYPES)[number];

// A background image reference is an opaque, ALREADY-MODERATED civitai Image id
// (civitai image ids are positive integers). The upload/scan/gate that PRODUCES
// a valid id is a SEPARATE PR (PR-C OPEN_IMAGE_UPLOAD); here we only bound the
// shape (a numeric id string, ≤20 chars) and re-validate it exists + is Scanned
// + within a SFW ceiling at publish time (validateGeneratorBackgroundImage).
export const generatorImageRefSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^\d+$/, 'backgroundImageRef must be a numeric image id');

// Per-button generation params. Mirrors the block workflow `params` caps, minus
// `prompt` (the per-button `promptTemplate` IS the prompt) — everything else is
// the same bounded surface so a published generator can't request a wider/costlier
// job than a live block submission.
export const generatorParamsSchema = z.object({
  negativePrompt: z.string().max(GEN_NEG_PROMPT_MAX).optional(),
  cfgScale: z.number().min(1).max(30).optional(),
  sampler: z.string().min(1).max(64).optional(),
  steps: z.number().int().min(1).max(STEPS_MAX).optional(),
  seed: z.number().int().nullish(),
  width: z.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
  height: z.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
  clipSkip: z.number().int().min(0).max(CLIP_SKIP_MAX).optional(),
  quantity: z.number().int().min(1).max(QUANTITY_MAX).default(1),
});
export type GeneratorParams = z.infer<typeof generatorParamsSchema>;

export const generatorLoraSchema = z.object({
  versionId: z.number().int().positive(),
  weight: z.number().min(GEN_LORA_WEIGHT_MIN).max(GEN_LORA_WEIGHT_MAX).default(1),
});
export type GeneratorLora = z.infer<typeof generatorLoraSchema>;

export const generatorButtonSchema = z.object({
  label: z.string().min(1).max(GEN_BUTTON_LABEL_MAX),
  workflowType: z.enum(GENERATOR_WORKFLOW_TYPES),
  checkpointVersionId: z.number().int().positive(),
  loras: z.array(generatorLoraSchema).max(GEN_MAX_LORAS_PER_BUTTON).default([]),
  // Free text — runs the content-safety belt (auditPromptServer) at publish.
  // Allowed empty (`exposedInputs.prompt` may supply the whole prompt at run time).
  promptTemplate: z.string().max(GEN_PROMPT_TEMPLATE_MAX).default(''),
  params: generatorParamsSchema,
  // Which run-time inputs the generator exposes to the end user. Additive bag;
  // consumed by PR-A's bridge / PR-C's host, not here.
  exposedInputs: z
    .object({
      prompt: z.boolean().optional(),
      image: z.boolean().optional(),
    })
    .default({}),
});
export type GeneratorButton = z.infer<typeof generatorButtonSchema>;

/**
 * The full published-generator value. `kind: 'generator'` DISCRIMINATES this
 * value from the existing text `{ title, body }` shared value at rest (so a
 * reader can branch on `value.kind`), and is written by the dedicated
 * `apps.shared.publishGenerator` mutation.
 */
export const generatorValueSchema = z.object({
  name: z.string().min(1).max(GEN_NAME_MAX),
  description: z.string().max(GEN_DESCRIPTION_MAX).optional(),
  buttons: z.array(generatorButtonSchema).min(1).max(GEN_MAX_BUTTONS),
  backgroundImageRef: generatorImageRefSchema.optional(),
});
export type GeneratorValue = z.infer<typeof generatorValueSchema>;

// The at-rest stored shape: the validated generator under a `kind` discriminator.
export type StoredGeneratorValue = { kind: 'generator'; generator: GeneratorValue };

/**
 * Collect the DISTINCT pinned resource version ids across every button
 * (checkpoint + each LoRA). This is the exact set G7 validates through the
 * generation gate. De-duped so a resource pinned by multiple buttons is gated
 * once.
 */
export function collectGeneratorVersionIds(generator: GeneratorValue): number[] {
  const ids = new Set<number>();
  for (const button of generator.buttons) {
    ids.add(button.checkpointVersionId);
    for (const lora of button.loras) ids.add(lora.versionId);
  }
  return [...ids];
}

/**
 * Collect every moderatable, CROSS-USER-VISIBLE free-text field for the
 * content-safety belt. Publish-time is the SOLE moderation gate for the
 * immutable stored row, so this must cover EVERY client-supplied string another
 * user can see: the generator `name`/`description`, and per button the `label`
 * (the button caption other users see), the `promptTemplate`, and the stored
 * `params.negativePrompt`. A POI/slur/phishing string fits in a 60-char label,
 * so the label is audited exactly like a prompt.
 */
export function collectGeneratorText(generator: GeneratorValue): string[] {
  const out: string[] = [generator.name];
  if (generator.description) out.push(generator.description);
  for (const button of generator.buttons) {
    out.push(button.label);
    if (button.promptTemplate) out.push(button.promptTemplate);
    if (button.params.negativePrompt) out.push(button.params.negativePrompt);
  }
  return out;
}
