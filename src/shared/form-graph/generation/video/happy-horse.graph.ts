import { defFamily, defineGraph } from 'form-graph';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import { happyHorseVersionIds } from '~/shared/data-graph/generation/version-ids';
import { checkpointDef } from '../checkpoint';
import {
  SEED,
  VIDEO,
  aspectRatioDef,
  enumDef,
  imagesDef,
  workflowScoped,
  sliderDef,
} from '../defs';
import { familyScope, modelIdOf, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * HappyHorse (v1.0 + v1.1), ported from `happy-horse-graph.ts`. Version picks
 * widen the aspect-ratio set for v1.1; ref2vid takes up to 9 references,
 * vid2vid:edit takes a source video plus an audio setting. No negative
 * prompt.
 */

// ---- copied from happy-horse-graph.ts, which dies with the data-graph engine

const happyHorseAspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const happyHorseV1_1AspectRatioList: GenerationAspectRatio[] = [
  ...happyHorseAspectRatioList,
  '21:9',
  '5:4',
  '4:5',
];

const happyHorseV1_1PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const happyHorseVersionOptions = [
  { label: 'v1.0', value: happyHorseVersionIds['v1.0'] },
  { label: 'v1.1', value: happyHorseVersionIds['v1.1'] },
];

const isHappyHorseV1_1 = (modelId?: number) => modelId === happyHorseVersionIds['v1.1'];

const happyHorseResolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

const happyHorseAudioSettings = [
  { label: 'Auto', value: 'auto' },
  { label: 'Origin', value: 'origin' },
] as const;

// ---- end of happy-horse-graph.ts copies -------------------------------------

const AR = defFamily((key: string) => {
  const [resolution, tier] = key.split('|') as ['720p' | '1080p', 'v11' | 'v10'];
  const v11 = tier === 'v11';
  return aspectRatioDef({
    options: getAspectRatioOptions(
      resolution,
      v11 ? happyHorseV1_1AspectRatioList : happyHorseAspectRatioList
    ),
    default: '16:9',
    priorityOptions: v11 ? happyHorseV1_1PriorityRatios : undefined,
  });
});

export const happyHorse = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: happyHorseVersionOptions },
      defaultModelId: happyHorseVersionIds['v1.1'],
    })
  )
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 9, warnOnMissingAiMetadata: true });
      if (_ext.workflow === 'vid2vid:edit') return imagesDef({ max: 9 });
      if (isWorkflowOrVariant(_ext.workflow, 'img2vid'))
        return imagesDef({ max: 1, warnOnMissingAiMetadata: true });
      return null;
    })
  )
  .field(
    'video',
    workflowScoped(({ _ext }) => (_ext.workflow === 'vid2vid:edit' ? VIDEO : null))
  )
  .field('resolution', enumDef({ options: happyHorseResolutions, default: '720p' }))
  .field('aspectRatio', ({ model, resolution, _ext }) =>
    _ext.workflow === 'txt2vid' || _ext.workflow === 'img2vid:ref2vid'
      ? AR(`${resolution}|${isHappyHorseV1_1(modelIdOf(model)) ? 'v11' : 'v10'}`)
      : null
  )
  .field('duration', sliderDef({ min: 3, max: 15, default: 5 }))
  .field('audioSetting', ({ _ext }) =>
    _ext.workflow === 'vid2vid:edit'
      ? enumDef({ options: happyHorseAudioSettings, default: 'auto' })
      : null
  )
  .field('seed', SEED)
  .use(promptOnlyTextBlock);

export {
  happyHorseVersionOptions,
  happyHorseResolutions,
  happyHorseAudioSettings,
  isHappyHorseV1_1,
};
