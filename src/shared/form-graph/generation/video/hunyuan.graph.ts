import { defineGraph } from 'form-graph';
import { getAspectRatioOptions } from '~/shared/constants/generation.constants';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, enumDef, imagesDef, sliderDef, workflowScoped } from '../defs';
import { familyResources, familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Hunyuan video (HyV1), ported from `hunyuan-graph.ts`. LoRAs supported;
 * cfg/steps sliders with presets, fixed durations. No negative prompt.
 */

// ---- copied from hunyuan-graph.ts, which dies with the data-graph engine ----

const hunyuanAspectRatios = getAspectRatioOptions('480p', ['16:9', '3:2', '1:1', '2:3', '9:16']);

const hunyuanDurations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
];

// ---- end of hunyuan-graph.ts copies -----------------------------------------

export const hunyuan = defineGraph<FamilyExt>({ scope: familyScope })
  .field(
    'images',
    workflowScoped(({ _ext }) =>
      !_ext.workflow.startsWith('txt') ? imagesDef({ warnOnMissingAiMetadata: true }) : null
    )
  )
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('seed', SEED)
  .field('aspectRatio', aspectRatioDef({ options: hunyuanAspectRatios, default: '1:1' }))
  .field(
    'cfgScale',
    sliderDef({
      min: 1,
      max: 10,
      step: 0.5,
      default: 6,
      presets: [
        { label: 'Low', value: 3 },
        { label: 'Balanced', value: 6 },
        { label: 'High', value: 9 },
      ],
    })
  )
  .field('duration', enumDef({ options: hunyuanDurations, default: 5 }))
  .field(
    'steps',
    sliderDef({
      min: 10,
      max: 30,
      default: 20,
      presets: [
        { label: 'Fast', value: 10 },
        { label: 'Balanced', value: 20 },
        { label: 'Quality', value: 30 },
      ],
    })
  )
  .field('resources', familyResources)
  .use(promptOnlyTextBlock);

export { hunyuanAspectRatios, hunyuanDurations };
