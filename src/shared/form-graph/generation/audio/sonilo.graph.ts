import type { z } from 'zod';
import { branch, defineGraph } from 'form-graph';
import {
  soniloDuration,
  soniloOperationOptions,
  soniloVersionIds,
  SONILO_MAX_PROMPT_LENGTH,
  type SoniloOperation,
} from '~/shared/constants/sonilo.constants';
import { checkpointDef } from '../checkpoint';
import { enumDef, sliderDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

type SoniloExt = FamilyExt & { soniloOperation?: SoniloOperation };

const music = defineGraph<SoniloExt>().field('duration', sliderDef(soniloDuration.music));
const soundEffect = defineGraph<SoniloExt>().field(
  'duration',
  sliderDef(soniloDuration.soundEffect)
);

const operations = branch('soniloOperation', [
  [['music'], music],
  [['soundEffect'], soundEffect],
] as const);

export const sonilo = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: [{ label: 'V1.1', value: soniloVersionIds['V1.1'] }] },
      defaultModelId: soniloVersionIds['V1.1'],
    })
  )
  .field('prompt', {
    ...textDef('prompt', SONILO_MAX_PROMPT_LENGTH),
    refine: (output: z.ZodString) =>
      output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' }),
    meta: {
      required: true,
      targetKey: 'prompt',
      snippets: undefined,
      triggerWords: [] as string[],
    },
  })
  .field('soniloOperation', enumDef({ options: soniloOperationOptions, default: 'music' }))
  .use(operations);
