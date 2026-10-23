import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SDXL_FULL_AR, SEED } from '../defs';
import { familyScope, makeTextBlock, versionModeOf, type FamilyExt } from '../shared';
import { comfyResourceBlock } from '../turbo';

/**
 * Base and SFT share one ecosystem (their LoRAs are interchangeable), so the
 * checkpoint picker is the only split and the orchestrator model derives from the
 * version id. Neither is distilled (both are CFG models), so SFT exposes steps,
 * CFG and negative prompt too.
 */

export type MossImageModel = 'sft' | 'base';

const mossImageVersionIds = { sft: 3409867, base: 3409868 } as const;

const mossImageVersionOptions = [
  { label: 'SFT', value: mossImageVersionIds.sft },
  { label: 'Base', value: mossImageVersionIds.base },
];

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const mossImageModelOf = versionModeOf(mossImageVersionIds, 'sft');

export const mossImage = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: mossImageVersionOptions },
    })
  )
  .use(
    comfyResourceBlock({
      cfgScale: { min: 1, max: 10, step: 0.5, default: 3 },
      steps: { min: 4, max: 60, default: 25 },
      // SFT 8-step LoRA
      turbo: { lora: 3411385 },
    })
  )
  .field('aspectRatio', SDXL_FULL_AR)
  .field('seed', SEED)
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));

export { mossImageVersionIds };
