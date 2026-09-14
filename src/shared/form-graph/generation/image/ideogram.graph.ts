import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SDXL_SQUARE_AR, SEED } from '../defs';
import {
  familyResources,
  familyScope,
  perModelSlider,
  promptOnlyTextBlock,
  type FamilyExt,
} from '../shared';

/**
 * Ideogram 4, ported from `ideogram-graph.ts`. Comfy engine, locked checkpoint,
 * LoRAs; no negative prompt, sampler or scheduler.
 */

// ---- copied from ideogram-graph.ts, which dies with the data-graph engine ---

export const ideogramVersionId = 3246186;

// ---- end of ideogram-graph.ts copies ----------------------------------------

export const ideogram = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: ideogramVersionId,
    })
  )
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 4 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 25 }))
  .use(promptOnlyTextBlock)
  .field('seed', SEED);
