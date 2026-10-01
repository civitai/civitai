/**
 * Ideogram Family Graph
 *
 * Controls for the Ideogram 4 ecosystem (comfy engine). Locked to the Civitai-hosted
 * checkpoint; LoRAs supported. No negative prompt, sampler or scheduler —
 * ComfyIdeogram4CreateImageGenInput takes none of them.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  sdxlFullAspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';

/** Ideogram 4 model version ID (CivitaiOfficial) */
export const ideogramVersionId = 3246186;

export const ideogramGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        modelLocked: true,
        defaultModelId: ideogramVersionId,
      }),
    []
  )
  .merge(createResourcesGraph())
  .node('aspectRatio', sdxlFullAspectRatioNode())
  .node('cfgScale', sliderNode({ min: 1, max: 10, defaultValue: 4, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 25 }))
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node('seed', seedNode());
