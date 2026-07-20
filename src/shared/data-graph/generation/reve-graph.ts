/**
 * Reve Family Graph
 *
 * Controls for the Reve ecosystem (Reve 2.1, FAL engine).
 * Model is locked; no LoRA support.
 *
 * Controls per ReveFalImageGenInput:
 * - aspectRatio: fixed ratios (21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16)
 *
 * No negative prompt, no cfgScale, no steps. A seed control is exposed for form
 * consistency, but the orchestrator input type does not currently accept a seed,
 * so it is not forwarded by the handler.
 *
 * Supports two workflows:
 * - txt2img: text-to-image (ReveCreateFalImageGenInput)
 * - img2img:edit: reference-image editing (ReveEditFalImageGenInput). Reve accepts
 *   multiple reference frames, addressed from the prompt as <frame>N</frame>.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  imagesNode,
  promptGraph,
  seedNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';

// =============================================================================
// Version Constants
// =============================================================================

/** Reve 2.1 model version ID */
export const reveVersionId = 3133202;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Reve aspect ratios (subset of ReveFalImageGenInput.aspectRatio; dims at native ~4K). */
const reveAspectRatios = [
  { label: '21:9', value: '21:9', width: 4096, height: 1755 },
  { label: '16:9', value: '16:9', width: 4096, height: 2304 },
  { label: '3:2', value: '3:2', width: 4096, height: 2731 },
  { label: '4:3', value: '4:3', width: 4096, height: 3072 },
  { label: '5:4', value: '5:4', width: 4096, height: 3277 },
  { label: '1:1', value: '1:1', width: 4096, height: 4096 },
  { label: '4:5', value: '4:5', width: 3277, height: 4096 },
  { label: '3:4', value: '3:4', width: 3072, height: 4096 },
  { label: '2:3', value: '2:3', width: 2731, height: 4096 },
  { label: '9:16', value: '9:16', width: 2304, height: 4096 },
];

/** Standard preferred ratios shown before the "More" overflow. */
const revePriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// =============================================================================
// Reve Graph
// =============================================================================

/**
 * Reve family controls. Model is locked to the single Reve 2.1 version, no
 * LoRAs, samplers, CFG scale, steps, or CLIP skip.
 */
export const reveGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        modelLocked: true,
        defaultModelId: reveVersionId,
      }),
    []
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  // Aspect ratio picker — shown only for txt2img. For img2img:edit the output
  // ratio is derived by Reve from the reference frames (aspectRatio: 'auto').
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({
        options: reveAspectRatios,
        defaultValue: '1:1',
        priorityOptions: revePriorityRatios,
      }),
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Reference frames — shown only for img2img:edit, hidden for txt2img. Reve
  // supports multiple frames, addressed from the prompt as <frame>N</frame>.
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ min: 1, max: 4 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node('seed', seedNode());
