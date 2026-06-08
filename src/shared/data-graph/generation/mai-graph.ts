/**
 * MAI Family Graph
 *
 * Controls for the MAI ecosystem (Microsoft MAI-Image-2.5, FAL engine).
 * Model is locked; no LoRA support.
 *
 * Controls per MaiImageCreateFalImageGenInput:
 * - aspectRatio: fixed ratios (21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16)
 *
 * No negative prompt, no cfgScale, no steps. A seed control is exposed for form
 * consistency, but the orchestrator input type does not currently accept a seed,
 * so it is not forwarded by the handler.
 *
 * Supports two workflows:
 * - txt2img: text-to-image (MaiImageCreateFalImageGenInput)
 * - img2img:edit: reference-image editing (MaiImageEditFalImageGenInput)
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

/** MAI-Image-2.5 model version ID */
export const maiVersionId = 3002140;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** MAI aspect ratios (matches MaiImageCreateFalImageGenInput.aspectRatio). */
const maiAspectRatios = [
  { label: '21:9', value: '21:9', width: 2520, height: 1080 },
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '3:2', value: '3:2', width: 1620, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '5:4', value: '5:4', width: 1350, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 1080, height: 1350 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '2:3', value: '2:3', width: 1080, height: 1620 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

/** Standard preferred ratios shown before the "More" overflow. */
const maiPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/**
 * Allowed aspect ratios for img2img:edit reference images. Derived from
 * maiAspectRatios so cropping stays in sync with the supported output ratios —
 * uploads that don't match one of these must be cropped before generating.
 */
export const maiCropAspectRatios = maiAspectRatios.map((r) => r.value as `${number}:${number}`);

// =============================================================================
// MAI Graph
// =============================================================================

/**
 * MAI family controls. Model is locked to the single MAI-Image-2.5 version,
 * no LoRAs, samplers, CFG scale, steps, or CLIP skip.
 */
export const maiGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        modelLocked: true,
        defaultModelId: maiVersionId,
      }),
    []
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  // Aspect ratio picker — shown only for txt2img. For img2img:edit the output
  // ratio is derived from the (cropped) reference image, so the picker is hidden.
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({
        options: maiAspectRatios,
        defaultValue: '1:1',
        priorityOptions: maiPriorityRatios,
      }),
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Reference images — shown only for img2img:edit, hidden for txt2img.
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 1, aspectRatios: maiCropAspectRatios }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node('seed', seedNode());
