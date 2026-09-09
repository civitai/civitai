/**
 * Muse Image Family Graph
 *
 * Controls for the Muse Image ecosystem (Meta Muse Image, FAL engine).
 * Model is locked; no LoRA support.
 *
 * Controls per MuseImageFalImageGenInput:
 * - aspectRatio: fixed ratios (21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 2:3, 9:16, 9:21)
 *
 * No negative prompt, no cfgScale, no steps, no seed — the orchestrator input
 * type accepts none of them.
 *
 * Supports two workflows:
 * - txt2img: text-to-image (MuseImageCreateFalImageGenInput)
 * - img2img:edit: reference-image editing (MuseImageEditFalImageGenInput)
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  imagesNode,
  promptGraph,
  snippetsGraph,
  triggerWordsGraph,
} from './common';

// =============================================================================
// Version Constants
// =============================================================================

/** Muse Image model version ID */
export const museImageVersionId = 3291238;

// =============================================================================
// Aspect Ratios
// =============================================================================

/**
 * Muse Image aspect ratios (MuseImageFalImageGenInput.aspectRatio minus 'auto',
 * which the handler reserves for editing). Long edge fixed at 2048 to match
 * fal's documented 16:9 output of 2048x1152.
 */
const museImageAspectRatios = [
  { label: '21:9', value: '21:9', width: 2048, height: 878 },
  { label: '16:9', value: '16:9', width: 2048, height: 1152 },
  { label: '3:2', value: '3:2', width: 2048, height: 1365 },
  { label: '4:3', value: '4:3', width: 2048, height: 1536 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1536, height: 2048 },
  { label: '2:3', value: '2:3', width: 1365, height: 2048 },
  { label: '9:16', value: '9:16', width: 1152, height: 2048 },
  { label: '9:21', value: '9:21', width: 878, height: 2048 },
];

/** Standard preferred ratios shown before the "More" overflow. */
const museImagePriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// =============================================================================
// Muse Image Graph
// =============================================================================

export const museImageGraph = new DataGraph<
  { ecosystem: string; workflow: string },
  GenerationCtx
>()
  .merge(
    () =>
      createCheckpointGraph({
        modelLocked: true,
        defaultModelId: museImageVersionId,
      }),
    []
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  // Aspect ratio picker — shown only for txt2img. For img2img:edit the output
  // ratio is derived by Muse Image from the reference images (aspectRatio: 'auto').
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({
        options: museImageAspectRatios,
        defaultValue: '1:1',
        priorityOptions: museImagePriorityRatios,
      }),
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Reference images — shown only for img2img:edit. Muse Image composes from a
  // tagged set of references, so more than one is accepted.
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ min: 1, max: 4 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  );
