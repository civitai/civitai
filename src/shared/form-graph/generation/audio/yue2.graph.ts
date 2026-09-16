import type { z } from 'zod';
import { defineGraph } from 'form-graph';
import { yue2Duration, yue2ModeOptions, yue2Steps } from '~/shared/constants/yue2.constants';
import { SEED, enumDef, sliderDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

export const yue2 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('musicDescription', {
    ...textDef('musicDescription'),
    refine: (output: z.ZodString) =>
      output.refine((v) => v.trim().length > 0, { message: 'Music description is required' }),
  })
  .field('lyrics', {
    ...textDef('lyrics'),
    refine: (output: z.ZodString) =>
      output.refine((v) => v.trim().length > 0, { message: 'Lyrics are required' }),
  })
  .field('duration', sliderDef(yue2Duration))
  .field('steps', sliderDef(yue2Steps))
  .field('seed', SEED)
  .field('yue2Mode', enumDef({ options: yue2ModeOptions, default: 'full' }))
  .field('yue2Abc', ({ yue2Mode }) => (yue2Mode !== 'off' ? textDef('yue2Abc') : null));
