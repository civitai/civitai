import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Mochi, ported from `mochi-graph.ts`. The smallest family: locked model,
 * seed, a prompt-enhancer toggle, prompt. No negative prompt.
 */

export const mochi = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({ ecosystem: _ext.ecosystem, workflow: _ext.workflow, ext: _ext })
  )
  .field('seed', SEED)
  .field('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    default: true,
  })
  .use(promptOnlyTextBlock);
