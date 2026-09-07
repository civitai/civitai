import { defineGraph } from 'form-graph';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import { checkpointDef } from '../checkpoint';
import {
  SEED,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  workflowScoped,
  sliderDef,
} from '../defs';
import { familyScope, makeTextBlock, type FamilyExt } from '../shared';

/**
 * Seedance (ByteDance), ported from `seedance-graph.ts`. No resources, no
 * negative prompt; resolution and duration ceilings depend on the model
 * version. The selection IS the backend — no emit needed.
 */

// ---- copied from seedance-graph.ts, which dies with the data-graph engine ---

export const seedanceVersionIds = {
  v2: 2864671,
  'v2-fast': 2868300,
  'v2-mini': 3069790,
  'v2.5': 3207504,
} as const;

const seedanceVersionOptions = [
  { label: 'v2', value: seedanceVersionIds.v2 },
  { label: 'v2 fast', value: seedanceVersionIds['v2-fast'] },
  { label: 'v2 mini', value: seedanceVersionIds['v2-mini'] },
  { label: 'v2.5', value: seedanceVersionIds['v2.5'] },
];

const seedanceAspectRatioList: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
];

const seedanceResolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
];

// v2 is the only model that supports 1080p
const seedanceResolutionsV2 = [...seedanceResolutions, { label: '1080p', value: '1080p' }];

// ---- end of seedance-graph.ts copies ----------------------------------------

export const seedance = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) => {
      // ref2vid before the img2vid check below, which treats it as a variant
      // and would cap it at one
      if (_ext.workflow === 'img2vid:ref2vid')
        return imagesDef({ max: 9, warnOnMissingAiMetadata: true });
      return isWorkflowOrVariant(_ext.workflow, 'img2vid') ? imagesDef({ max: 1 }) : null;
    })
  )
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: seedanceVersionOptions },
      defaultModelId: seedanceVersionIds['v2-mini'],
    })
  )
  .field('resolution', ({ model }) =>
    enumDef({
      options: model?.id === seedanceVersionIds.v2 ? seedanceResolutionsV2 : seedanceResolutions,
      default: '720p',
    })
  )
  // aspect-ratio dimensions scale with the selected resolution
  .field('aspectRatio', ({ resolution }) =>
    aspectRatioDef({
      options: getAspectRatioOptions(resolution, seedanceAspectRatioList),
      default: '16:9',
    })
  )
  .field('duration', ({ model }) =>
    sliderDef({ min: 4, max: model?.id === seedanceVersionIds['v2.5'] ? 30 : 15, default: 5 })
  )
  .field('generateAudio', boolDef(false))
  .field('seed', SEED)
  .use(makeTextBlock({ negativePrompt: false }));
