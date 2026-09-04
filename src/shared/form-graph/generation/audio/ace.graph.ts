import { z } from 'zod';
import { branch, defineGraph, type FieldDef } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, boolDef, enumDef, imagesDef, sliderDef, textDef } from '../defs';
import { familyScope, modelIdOf, type FamilyExt } from '../shared';

/**
 * ACE Audio, ported from `ace-audio-graph.ts`. Simple mode is a single prompt
 * (the handler drafts lyrics/description via chatCompletion); custom mode is
 * the full control surface. cfg/steps ranges and defaults follow the model
 * variant (turbo vs base). No snippets — v1 merges triggerWordsGraph only.
 */

// ---- copied from ace-audio-graph.ts, which dies with the data-graph engine --

export type AceAudioMode = 'simple' | 'custom';

const aceAudioModeOptions = [
  { label: 'Simple', value: 'simple' as const },
  { label: 'Custom', value: 'custom' as const },
];

export const aceAudioVersionIds = {
  xlTurbo: 2864949,
  turbo: 2864880,
  xlSft: 2864917,
  xlBase: 2864892,
  base: 2864864,
} as const;

type AceAudioVariant = 'turbo' | 'base';

const aceAudioVersionOptions = [
  { label: 'XL Turbo', value: aceAudioVersionIds.xlTurbo },
  { label: 'Turbo', value: aceAudioVersionIds.turbo },
  { label: 'XL SFT', value: aceAudioVersionIds.xlSft },
  { label: 'XL Base', value: aceAudioVersionIds.xlBase },
  { label: 'Base', value: aceAudioVersionIds.base },
];

const versionIdToVariant = new Map<number, AceAudioVariant>([
  [aceAudioVersionIds.xlTurbo, 'turbo'],
  [aceAudioVersionIds.turbo, 'turbo'],
  [aceAudioVersionIds.xlSft, 'base'],
  [aceAudioVersionIds.xlBase, 'base'],
  [aceAudioVersionIds.base, 'base'],
]);

const resolveVariant = (modelId?: number): AceAudioVariant =>
  (modelId ? versionIdToVariant.get(modelId) : undefined) ?? 'turbo';

const ACE_AUDIO_MIN_DURATION = 1;
const ACE_AUDIO_MAX_DURATION = 190;
const ACE_AUDIO_DEFAULT_DURATION = 60;

const ACE_AUDIO_MIN_BPM = 40;
const ACE_AUDIO_MAX_BPM = 200;
const ACE_AUDIO_DEFAULT_BPM = 120;

const MAX_DESCRIPTION_LENGTH = 1000;

// ---- end of ace-audio-graph.ts copies ---------------------------------------

type AceExt = FamilyExt & { model?: unknown; triggerWords?: string[] };

/** v1's textNode editors read triggerWords off ctx; no snippets graph here. */
const editorMeta = (name: string, required: boolean, triggerWords: string[] | undefined) => ({
  required,
  targetKey: name,
  snippets: undefined,
  triggerWords: triggerWords ?? [],
});

const requiredText = (name: string, message: string, maxLength?: number) => ({
  ...textDef(name, maxLength),
  refine: (output: z.ZodString) => output.refine((v) => v.trim().length > 0, { message }),
});

const simple = defineGraph<AceExt>().field('prompt', ({ _ext }) => ({
  ...requiredText('prompt', 'Prompt is required'),
  meta: editorMeta('prompt', true, _ext.triggerWords),
}));

/** 0-1 weight — unbounded coerce input, bounded output, like v1's node. */
const WEIGHT: FieldDef<number, { min: number; max: number; step: number }> = {
  input: z.coerce.number().optional(),
  output: z.number().min(0).max(1),
  default: 0.5,
  meta: { min: 0, max: 1, step: 0.1 },
};

const custom = defineGraph<AceExt>()
  // v1's model effect fires at parse init and stomps cfg/steps to the
  // variant's defaults — at the parse boundary they are pinned, not free
  .field('cfgScale', ({ _ext }) => {
    const target = resolveVariant(modelIdOf(_ext.model)) === 'turbo' ? 1 : 4;
    return {
      ...sliderDef({ min: 0.5, max: 10, step: 0.5, default: target }),
      correct: (value: number) =>
        value !== target ? { value: target, reason: 'variant_default' } : undefined,
    };
  })
  .field('steps', ({ _ext }) => {
    const isTurbo = resolveVariant(modelIdOf(_ext.model)) === 'turbo';
    const target = isTurbo ? 8 : 50;
    return {
      ...sliderDef({ min: 1, max: isTurbo ? 20 : 100, default: target }),
      correct: (value: number) =>
        value !== target ? { value: target, reason: 'variant_default' } : undefined,
    };
  })
  .field('title', {
    input: z.string().optional(),
    output: z.string().trim().max(100, 'Title is too long').optional(),
    default: '',
  })
  .field('musicDescription', ({ _ext }) => ({
    ...requiredText('musicDescription', 'Music description is required', MAX_DESCRIPTION_LENGTH),
    meta: editorMeta('musicDescription', true, _ext.triggerWords),
  }))
  .field('lyrics', ({ _ext }) => ({
    ...textDef('lyrics'),
    meta: editorMeta('lyrics', false, _ext.triggerWords),
  }))
  .field('bpm', {
    input: z.coerce.number().optional(),
    output: z.number().min(ACE_AUDIO_MIN_BPM).max(ACE_AUDIO_MAX_BPM),
    default: ACE_AUDIO_DEFAULT_BPM,
    meta: { min: ACE_AUDIO_MIN_BPM, max: ACE_AUDIO_MAX_BPM },
  })
  .field('instrumentalWeight', WEIGHT)
  .field('vocalWeight', WEIGHT);

/** Keyed on the `aceAudioMode` field, declared before the dispatch. */
const modes = branch('aceAudioMode', [
  [['simple'], simple],
  [['custom'], custom],
] as const);

export const ace = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: aceAudioVersionOptions },
      defaultModelId: aceAudioVersionIds.xlTurbo,
    })
  )
  .computed('triggerWords', ({ model }) => model?.trainedWords ?? [])
  .field('generateCover', boolDef(false))
  .field('images', ({ generateCover }) =>
    !generateCover ? imagesDef({ min: 0, max: 1, aspectRatios: ['1:1'] }) : null
  )
  .field('seed', SEED)
  .field('duration', {
    input: z.coerce.number().optional(),
    output: z.number().min(ACE_AUDIO_MIN_DURATION).max(ACE_AUDIO_MAX_DURATION),
    default: ACE_AUDIO_DEFAULT_DURATION,
    meta: { min: ACE_AUDIO_MIN_DURATION, max: ACE_AUDIO_MAX_DURATION },
  })
  .field('aceAudioMode', enumDef({ options: aceAudioModeOptions, default: 'simple' }))
  .use(modes)
  // v1: switching models resets cfg/steps to the variant's defaults, so a
  // base-range value can't survive onto a turbo model's smaller range
  .effect({
    model: (model: unknown) => {
      const isTurbo = resolveVariant(modelIdOf(model)) === 'turbo';
      return { cfgScale: isTurbo ? 1 : 4, steps: isTurbo ? 8 : 50 };
    },
  });

export {
  ACE_AUDIO_MIN_DURATION,
  ACE_AUDIO_MAX_DURATION,
  ACE_AUDIO_DEFAULT_DURATION,
  ACE_AUDIO_MIN_BPM,
  ACE_AUDIO_MAX_BPM,
  ACE_AUDIO_DEFAULT_BPM,
  aceAudioModeOptions,
  aceAudioVersionOptions,
  resolveVariant,
};
