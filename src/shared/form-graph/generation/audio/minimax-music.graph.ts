import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, enumDef, sliderDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * MiniMax Music 3, ported from `minimax-music-graph.ts`. Simple mode is a
 * single prompt (the handler drafts caption + lyrics via chatCompletion);
 * custom mode writes both directly — the step input requires BOTH, so unlike
 * ACE the lyrics are required. cfg/steps/topK deliberately absent (the
 * orchestrator's defaults stand).
 */

// ---- copied from minimax-music-graph.ts, which dies with the data-graph engine

export type MinimaxMusicMode = 'simple' | 'custom';

const minimaxMusicModeOptions = [
  { label: 'Simple', value: 'simple' as const },
  { label: 'Custom', value: 'custom' as const },
];

export const minimaxMusicVersionIds = {
  'v3.0': 3225593,
} as const;

const MINIMAX_MUSIC_MIN_DURATION = 30;
const MINIMAX_MUSIC_MAX_DURATION = 300;
const MINIMAX_MUSIC_DEFAULT_DURATION = 60;

const MAX_CAPTION_LENGTH = 2000;

// ---- end of minimax-music-graph.ts copies -----------------------------------

type MinimaxMusicExt = FamilyExt & { minimaxMusicMode?: MinimaxMusicMode };

const editorMeta = (name: string, required: boolean) => ({
  required,
  targetKey: name,
  snippets: undefined,
  triggerWords: [] as string[],
});

const requiredText = (name: string, message: string, maxLength?: number) => {
  const base = textDef(name, maxLength);
  return {
    ...base,
    output: base.output.refine((v) => v.trim().length > 0, { message }),
  };
};

const simple = defineGraph<MinimaxMusicExt>().field('prompt', {
  ...requiredText('prompt', 'Prompt is required'),
  meta: editorMeta('prompt', true),
});

const custom = defineGraph<MinimaxMusicExt>()
  .field('musicDescription', {
    ...requiredText('musicDescription', 'Music description is required', MAX_CAPTION_LENGTH),
    meta: editorMeta('musicDescription', true),
  })
  .field('lyrics', {
    ...requiredText('lyrics', 'Lyrics are required'),
    meta: editorMeta('lyrics', true),
  });

/** Keyed on the `minimaxMusicMode` field, declared before the dispatch. */
const modes = branch('minimaxMusicMode', [
  [['simple'], simple],
  [['custom'], custom],
] as const);

export const minimaxMusic = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: [{ label: 'v3.0', value: minimaxMusicVersionIds['v3.0'] }] },
      defaultModelId: minimaxMusicVersionIds['v3.0'],
    })
  )
  .field('seed', SEED)
  // a cap, not a target — clamps (sliderDef) so a duration carried over from a
  // video ecosystem can't fail validation with nothing on screen to say why
  .field(
    'duration',
    sliderDef({
      min: MINIMAX_MUSIC_MIN_DURATION,
      max: MINIMAX_MUSIC_MAX_DURATION,
      step: 10,
      default: MINIMAX_MUSIC_DEFAULT_DURATION,
    })
  )
  .field('minimaxMusicMode', enumDef({ options: minimaxMusicModeOptions, default: 'simple' }))
  .use(modes);

export {
  MINIMAX_MUSIC_MIN_DURATION,
  MINIMAX_MUSIC_MAX_DURATION,
  MINIMAX_MUSIC_DEFAULT_DURATION,
  minimaxMusicModeOptions,
};
