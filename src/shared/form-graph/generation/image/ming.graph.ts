import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { mingAspectRatios, mingResolutions } from '~/shared/constants/ming.constants';
import { SEED, aspectRatioDef, img2imgImages, resourcesDef, sliderDef } from '../defs';
import { familyScope, makeTextBlock, type FamilyExt } from '../shared';

/** Uses the built-in Design checkpoint without depending on an official model card. */
export const ming = defineGraph<FamilyExt>({ scope: familyScope })
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
