import { z } from 'zod';
import { defFamily, defineGraph } from 'form-graph';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { checkpointDef } from '../checkpoint';
import {
  optionFallback,
  SEED,
  aspectRatioDef,
  boolDef,
  enumDef,
  imagesDef,
  workflowScoped,
} from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Sora 2. Locked model; resolution tier drives
 * aspect-ratio dims, aspect ratio only on txt2vid; pro toggle and fixed
 * durations. No negative prompt.
 */

const soraAspectRatioList: GenerationAspectRatio[] = ['16:9', '9:16'];

const soraResolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

const soraDurations = [
  { label: '4 seconds', value: 4 },
  { label: '8 seconds', value: 8 },
];

const AR = defFamily((resolution: string) =>
  aspectRatioDef({
    options: getAspectRatioOptions(resolution as '720p' | '1080p', soraAspectRatioList),
    default: '9:16',
  })
);

export const sora = defineGraph<FamilyExt>({ scope: familyScope })
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
  .field('resolution', {
    input: z.enum(['720p', '1080p']).optional(),
    output: z.enum(['720p', '1080p']),
    default: '720p' as const,
    correct: optionFallback(['720p', '1080p'] as const, '720p'),
    meta: { options: soraResolutions },
  })
  .field('aspectRatio', ({ resolution, _ext }) =>
    _ext.workflow === 'txt2vid' ? AR(resolution) : null
  )
  .field('usePro', boolDef(false))
  .field('duration', enumDef({ options: soraDurations, default: 4 }))
  .use(promptOnlyTextBlock);

export { soraResolutions, soraDurations };
