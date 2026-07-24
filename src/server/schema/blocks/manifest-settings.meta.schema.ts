import * as z from 'zod';
import safeRegex from 'safe-regex';

/**
 * W3 v0 — manifest-driven settings declaration.
 *
 * Validates the `settings` block on a `block.manifest.json` at push/submission
 * time (W2 webhook handler) AND drives the generic runtime validator
 * (`validateBlockSettings`) that replaces the in-tree per-block-id schema map.
 *
 * The shape is intentionally narrower than full JSON Schema — only the
 * widget set the platform actually renders. New widgets in v1 extend the
 * `settingFieldSchema` discriminated union without breaking existing
 * manifests.
 *
 * Keep the structural shape in lockstep with `ManifestSettings` /
 * `ManifestSettingField` in `packages/civitai-app-sdk/src/blocks/types.ts`
 * (civitai-app-starters PR #11). Adding a field on either side without the
 * other will silently degrade the SettingsForm renderer.
 */

const MAX_SETTINGS_PER_BLOCK = 32;
const MAX_LABEL_LEN = 80;
const MAX_DESCRIPTION_LEN = 280;
const MAX_REQUIRES_SCOPE_LEN = 64;
// Cap string `default` / `enum` / `pattern` payloads so a hostile manifest
// can't blow up the meta-schema parse time.
const MAX_STRING_DEFAULT_LEN = 10_000;
const MAX_ENUM_OPTIONS = 64;
const MAX_PATTERN_LEN = 256;

/**
 * Hard ceiling on the input a developer-authored `pattern` regex is ever run
 * against. A field declaring a `pattern` MUST also declare `max_length`, and
 * that max_length is capped at this value — so the viewer save path can never
 * feed an unbounded string into a `new RegExp(pattern).test(input)` call. Also
 * consumed by the runtime validator (`settings-validator.service.ts`) as a
 * belt-and-suspenders cap for any pattern stored before this gate existed.
 *
 * Bounding the input fully tames *polynomial* backtracking; the *exponential*
 * case is caught up front by the `safe-regex` gate below (input length can't
 * save you from an exponential blowup — ~40 chars already freezes `(a+)+$`).
 */
export const MAX_PATTERNED_INPUT_LEN = 1000;

/**
 * Snake_case identifier used as the key in the settings record. Mirrors
 * the existing `blockId` / setting key convention; rejecting other casings
 * keeps JSON payloads predictable for downstream JSONB queries.
 */
const settingKeyPattern = /^[a-z][a-z0-9_]{0,40}$/;

const baseFieldSchema = z.object({
  scope: z.enum(['publisher', 'viewer']),
  label: z.string().min(1).max(MAX_LABEL_LEN),
  description: z.string().min(1).max(MAX_DESCRIPTION_LEN),
  /**
   * Only render this field when the app declared the named scope. Lets the
   * publisher settings UI hide a "Max Buzz per generation" control on a
   * block that doesn't request `ai:write:budgeted` — the field semantically
   * doesn't apply.
   */
  requires_scope: z.string().min(1).max(MAX_REQUIRES_SCOPE_LEN).optional(),
});

const numberFieldSchema = baseFieldSchema.extend({
  type: z.literal('number'),
  widget: z.enum(['number', 'slider', 'resource_picker']).default('number'),
  default: z.number().nullable().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  /**
   * Widget-specific options the form generator interprets. For
   * `resource_picker`: `{ resource_type: 'Checkpoint' | 'LORA' | ..., filter_by_ecosystem?: boolean }`.
   * Intentionally untyped here — the form generator owns the widget contract.
   */
  widget_options: z.record(z.string(), z.unknown()).optional(),
});

const stringFieldSchema = baseFieldSchema.extend({
  type: z.literal('string'),
  widget: z.enum(['text', 'textarea', 'select']).default('text'),
  default: z.string().max(MAX_STRING_DEFAULT_LEN).nullable().optional(),
  max_length: z.number().int().positive().max(MAX_STRING_DEFAULT_LEN).optional(),
  /** RegExp source. Compiled at validate-time. */
  pattern: z.string().max(MAX_PATTERN_LEN).optional(),
  /** Required when widget = 'select'. */
  enum: z.array(z.string().max(MAX_STRING_DEFAULT_LEN)).max(MAX_ENUM_OPTIONS).optional(),
});

const booleanFieldSchema = baseFieldSchema.extend({
  type: z.literal('boolean'),
  widget: z.literal('toggle').default('toggle'),
  default: z.boolean().optional(),
});

export const settingFieldSchema = z.discriminatedUnion('type', [
  numberFieldSchema,
  stringFieldSchema,
  booleanFieldSchema,
]);

export type ManifestSettingField = z.infer<typeof settingFieldSchema>;

/**
 * The settings declaration on a manifest. Keyed by snake_case field name.
 * Capped at MAX_SETTINGS_PER_BLOCK fields to bound the per-install JSONB
 * payload size + form generator render cost.
 *
 * Empty record is valid — apps that don't expose settings just omit the
 * `settings` key on the manifest.
 */
const recordSchema = z.record(
  z
    .string()
    .regex(
      settingKeyPattern,
      'settings keys must be snake_case (a-z0-9_, must start with a letter, max 41 chars)'
    ),
  settingFieldSchema
);

export type ManifestSettings = z.infer<typeof recordSchema>;

export const manifestSettingsSchema = recordSchema.superRefine(
  (settings: ManifestSettings, ctx) => {
    if (Object.keys(settings).length > MAX_SETTINGS_PER_BLOCK) {
      ctx.addIssue({
        code: 'custom',
        message: `max ${MAX_SETTINGS_PER_BLOCK} settings per block`,
      });
    }
    // Cross-field checks the per-field discriminated union can't express.
    for (const [key, def] of Object.entries(settings)) {
      if (def.type === 'number') {
        if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'min must be <= max' });
        }
        if (typeof def.default === 'number') {
          if (def.min !== undefined && def.default < def.min) {
            ctx.addIssue({ code: 'custom', path: [key, 'default'], message: 'default below min' });
          }
          if (def.max !== undefined && def.default > def.max) {
            ctx.addIssue({ code: 'custom', path: [key, 'default'], message: 'default above max' });
          }
        }
      }
      if (def.type === 'string') {
        if (def.widget === 'select') {
          if (!def.enum || def.enum.length === 0) {
            ctx.addIssue({
              code: 'custom',
              path: [key, 'enum'],
              message: 'widget=select requires enum',
            });
          } else if (typeof def.default === 'string' && !def.enum.includes(def.default)) {
            ctx.addIssue({
              code: 'custom',
              path: [key, 'default'],
              message: 'default not in enum',
            });
          }
        }
        if (def.pattern !== undefined) {
          let compiles = true;
          try {
            new RegExp(def.pattern);
          } catch {
            compiles = false;
            ctx.addIssue({
              code: 'custom',
              path: [key, 'pattern'],
              message: 'pattern is not a valid RegExp source',
            });
          }
          // A pattern can COMPILE and still be catastrophically exponential
          // (e.g. `(a+)+$`, `(x+x+)+y`, `(.*)*` — ~40 chars freeze the event
          // loop). The runtime validator runs `new RegExp(def.pattern).test(raw)`
          // on VIEWER-supplied input, and manifests are only mod-reviewed
          // (semi-trusted), so reject super-linear patterns at submission —
          // safe-regex flags nested/unbounded quantifiers (star height > 1).
          if (compiles && !safeRegex(def.pattern)) {
            ctx.addIssue({
              code: 'custom',
              path: [key, 'pattern'],
              message:
                'pattern is too complex — it may cause catastrophic backtracking (nested or unbounded quantifiers are not allowed)',
            });
          }
          // Bound the input the regex ever runs on: a patterned field MUST
          // declare a max_length, capped hard at MAX_PATTERNED_INPUT_LEN.
          if (def.max_length === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [key, 'max_length'],
              message: 'max_length is required when a pattern is declared',
            });
          } else if (def.max_length > MAX_PATTERNED_INPUT_LEN) {
            ctx.addIssue({
              code: 'custom',
              path: [key, 'max_length'],
              message: `max_length must be <= ${MAX_PATTERNED_INPUT_LEN} when a pattern is declared`,
            });
          }
        }
      }
    }
  }
);
