import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { mingAspectRatios, mingResolutions } from '~/shared/constants/ming.constants';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, img2imgImages, resourcesDef, sliderDef } from '../defs';
import { familyScope, makeTextBlock, type FamilyExt } from '../shared';

// The locked default version comes from `ecosystemSettings` rather than an argument here, so the
// id the picker shows and the AIR the handler bills against cannot drift apart.
export const ming = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('resources', ({ _ext }) =>
    resourcesDef({
      ecosystem: _ext.ecosystem,
      resourceTypes: ['LORA'],
      limit: _ext.limits.maxResources,
    })
  )
  .field('resolution', {
    input: z.enum(mingResolutions).optional(),
    output: z.enum(mingResolutions),
    default: '1K',
    meta: { options: mingResolutions.map((value) => ({ label: value, value })) },
  })
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2img'
      ? aspectRatioDef({ options: mingAspectRatios[resolution], default: '1:1' })
      : null
  )
  .field('images', img2imgImages({ min: 1, max: 3 }))
  .field('cfgScale', sliderDef({ min: 0, max: 30, default: 1, step: 0.5 }))
  .field('steps', sliderDef({ min: 1, max: 150, default: 12 }))
  .use(makeTextBlock({ promptAlwaysRequired: true }))
  .field('seed', SEED);
