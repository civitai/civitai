import * as z from 'zod';
import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import { REMIX_UPSCALE_SCALES } from '~/shared/remix-apps/define';

/**
 * A remix app stored as data: an `app_blocks` row whose manifest carries `kind: 'remix'` and a
 * `remix` spec. Declarative specs run through `compileRemixApp`; a `code` spec names an app that
 * stays in code (`CODE_REMIX_APPS`) and takes only its listing fields from the row.
 */

/**
 * The `app_blocks.status` of a remix app row. Never 'approved': every App Blocks read that serves
 * apps (store, token mint, health, analytics) filters on 'approved' or on a listing, so these
 * rows stay invisible to all of it. Reads that take every block exclude these.
 */
export const REMIX_STATUS = { enabled: 'remix', disabled: 'remix_disabled' } as const;
export const REMIX_STATUSES: string[] = Object.values(REMIX_STATUS);

export const REMIX_SLOT_IDS = ['image.remix', 'video.remix'] as const;
export type RemixSlotId = (typeof REMIX_SLOT_IDS)[number];
/** The slots a mod may save an app into. `video.remix` exists, but no app runs on video yet. */
export const REMIX_SAVABLE_SLOT_IDS = ['image.remix'] as const satisfies readonly RemixSlotId[];

/** The menu draws these; any other icon would render as the fallback. */
export const REMIX_APP_ICONS = [
  'sparkles',
  'camera',
  'toy',
  'grid',
  'pencil',
  'clay',
  'pick',
  'palette',
] as const;

export const REMIX_CODE_APP_SLUGS = ['pick-of-four'] as const;

const ASPECT_RATIOS = [
  '21:9',
  '16:9',
  '3:2',
  '5:4',
  '4:3',
  '1:1',
  '3:4',
  '4:5',
  '2:3',
  '9:16',
] as const satisfies readonly GenerationAspectRatio[];

/**
 * The engine a saved row may name for each tier: the remix edit engine of that tier. Only the
 * safe one runs safe sources under a provider policy, which a free-text ask relies on.
 */
const ENGINE_FOR_TIER = {
  safe: REMIX_ENGINES.edit.safe,
  mature: REMIX_ENGINES.edit.mature,
} as const;

const engine = z.strictObject({
  ecosystem: z.string().min(1).max(64),
  versionId: z.number().int().positive(),
});

const id = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,31}$/, 'Use letters and digits, starting with a lowercase letter');
const text = (max: number) => z.string().trim().min(1).max(max);

const textAsk = z.strictObject({
  id,
  kind: z.literal('text'),
  prompt: text(120),
  maxLength: z.number().int().min(1).max(500),
  optional: z.boolean().optional(),
  /** Put around a non-blank answer where `{{id}}` appears; a blank answer fills in ''. */
  wrap: z.strictObject({ before: z.string().max(200), after: z.string().max(200) }).optional(),
});

const choiceAsk = z.strictObject({
  id,
  kind: z.literal('choice'),
  prompt: text(120),
  options: z
    .array(
      z.strictObject({
        value: z.string().regex(/^[a-z0-9-]{1,40}$/),
        label: text(60),
        /** Text each `{{key}}` in a step prompt becomes when this option is picked. */
        fragments: z.record(id, z.string().min(1).max(500)),
      })
    )
    .min(2)
    .max(12),
});

const imageStep = z.strictObject({
  kind: z.literal('image'),
  prompt: text(2000),
  aspectRatio: z.enum(['source', ...ASPECT_RATIOS]),
  quantity: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  /** `previous`: the first image the step before returned. */
  input: z.enum(['source', 'previous']),
});

const upscaleStep = z.strictObject({
  kind: z.literal('upscale'),
  scale: z.literal(REMIX_UPSCALE_SCALES),
});

const declarativeSpec = z.strictObject({
  icon: z.enum(REMIX_APP_ICONS),
  engine: z.strictObject({ safe: engine, mature: engine.optional() }),
  asks: z.array(z.discriminatedUnion('kind', [textAsk, choiceAsk])).max(4),
  steps: z
    .array(z.discriminatedUnion('kind', [imageStep, upscaleStep]))
    .min(1)
    .max(4),
});

const codeSpec = z.strictObject({
  icon: z.enum(REMIX_APP_ICONS),
  code: z.enum(REMIX_CODE_APP_SLUGS),
});

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export function placeholdersOf(prompt: string) {
  return [...prompt.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Where `spec` names an engine other than today's remix edit engine for its tier. Checked on save
 * only: a stored row keeps serving after an engine version bump moves the allowlist on.
 */
export function remixEngineIssues(spec: RemixAppSpec) {
  if ('code' in spec) return [];
  const issues: { path: (string | number)[]; message: string }[] = [];
  for (const tier of ['safe', 'mature'] as const) {
    const named = spec.engine[tier];
    const allowed = ENGINE_FOR_TIER[tier];
    if (
      named &&
      (named.ecosystem !== allowed.ecosystemKey || named.versionId !== allowed.modelVersionId)
    )
      issues.push({
        path: ['engine', tier],
        message: `Use the remix ${tier} engine: ${allowed.ecosystemKey} ${allowed.modelVersionId}`,
      });
  }
  return issues;
}

/** A spec's shape and wiring, without the engine allowlist: what a stored row must satisfy. */
const storedSpecSchema = z.union([declarativeSpec, codeSpec]).superRefine((spec, ctx) => {
  if ('code' in spec) return;
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  // Every name in use, and whether a prompt can fill it: a choice's own id fills nothing.
  const names = new Map<string, boolean>();
  const claim = (name: string, fills: boolean, path: (string | number)[]) => {
    if (names.has(name)) issue(path, `"${name}" is already used`);
    names.set(name, fills);
  };
  spec.asks.forEach((ask, a) => {
    claim(ask.id, ask.kind === 'text', ['asks', a, 'id']);
    if (ask.kind !== 'choice') return;
    const values = new Set<string>();
    const keys = Object.keys(ask.options[0].fragments).sort().join(',');
    ask.options.forEach((option, o) => {
      if (values.has(option.value)) issue(['asks', a, 'options', o, 'value'], 'Repeated value');
      values.add(option.value);
      if (Object.keys(option.fragments).sort().join(',') !== keys)
        issue(['asks', a, 'options', o, 'fragments'], 'Every option needs the same fragments');
    });
    for (const key of Object.keys(ask.options[0].fragments))
      claim(key, true, ['asks', a, 'options', 0, 'fragments', key]);
  });

  spec.steps.forEach((step, s) => {
    if (s === 0 && (step.kind === 'upscale' || step.input === 'previous'))
      issue(['steps', s], 'The first step works on the source image');
    if (step.kind !== 'image') return;
    for (const name of placeholdersOf(step.prompt))
      if (!names.get(name)) issue(['steps', s, 'prompt'], `{{${name}}} is not an ask or fragment`);
  });
});

/** What a save must satisfy: the stored shape, on today's engines. */
export const remixAppSpecSchema = storedSpecSchema.superRefine((spec, ctx) => {
  for (const { path, message } of remixEngineIssues(spec))
    ctx.addIssue({ code: 'custom', path, message });
});

export type RemixAppSpec = z.infer<typeof remixAppSpecSchema>;
export type RemixDeclarativeSpec = Extract<RemixAppSpec, { steps: unknown }>;
export type RemixCodeSpec = Extract<RemixAppSpec, { code: unknown }>;

/** A row's `blockId` is this plus its slug, inside the 40-character blockId limit. */
export const REMIX_BLOCK_ID_PREFIX = 'remix-';
export const remixAppSlugSchema = z.string().regex(/^[a-z][a-z0-9-]{1,32}[a-z0-9]$/);

/**
 * What a mod writes: everything but enabled and order, which have their own actions. The outer
 * object strips unknown keys (tRPC middleware adds `browsingLevel` to every input); the spec,
 * which is what runs, refuses them.
 */
export const remixAppInputSchema = z.object({
  slug: remixAppSlugSchema,
  name: text(40),
  description: z.string().trim().max(200).optional(),
  /** A new app takes a savable slot; a save may keep a stored row's other slot. */
  target: z.enum(REMIX_SLOT_IDS),
  spec: remixAppSpecSchema,
});
export type RemixAppInput = z.infer<typeof remixAppInputSchema>;

/** The manifest stored on the row. `version` mirrors `app_blocks.version`. */
export const remixManifestSchema = z.object({
  kind: z.literal('remix'),
  name: text(40),
  description: z.string().max(200).optional(),
  /** `<run version>.0.0`: semver like every block's, with the run version as its major. */
  version: z.string().regex(/^[1-9][0-9]*\.0\.0$/),
  targets: z.tuple([z.object({ slotId: z.enum(REMIX_SLOT_IDS) })]),
  remix: storedSpecSchema,
});
export type RemixManifest = z.infer<typeof remixManifestSchema>;
