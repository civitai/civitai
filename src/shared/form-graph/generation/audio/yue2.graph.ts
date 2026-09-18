import type { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import {
  yue2Duration,
  yue2ModeOptions,
  yue2MusicModeOptions,
  yue2Steps,
} from '~/shared/constants/yue2.constants';
import { SEED, enumDef, sliderDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

type YuE2Ext = FamilyExt & { yue2MusicMode?: 'simple' | 'custom' };

const simple = defineGraph<YuE2Ext>().field('prompt', {
  ...textDef('prompt'),
  refine: (output: z.ZodString) =>
    output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' }),
  meta: { required: true, targetKey: 'prompt', snippets: undefined, triggerWords: [] as string[] },
});

const custom = defineGraph<YuE2Ext>()
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
  .field('steps', sliderDef(yue2Steps))
  .field('yue2Mode', enumDef({ options: yue2ModeOptions, default: 'full' }))
  .field('yue2Abc', ({ yue2Mode }) => (yue2Mode !== 'off' ? textDef('yue2Abc') : null));

export const yue2 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('duration', sliderDef(yue2Duration))
  .field('seed', SEED)
  .field('yue2MusicMode', enumDef({ options: yue2MusicModeOptions, default: 'simple' }))
  .use(
    branch('yue2MusicMode', [
      [['simple'], simple],
      [['custom'], custom],
    ] as const)
  );
