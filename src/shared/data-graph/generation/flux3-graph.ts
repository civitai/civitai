/** FLUX 3 Image (fal). No LoRA/cfg/steps/seed nodes: Flux3FalImageGenInput takes none of them. */

import z from 'zod';
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

export const flux3VersionId = 3376170;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Flux3FalImageGenInput.aspectRatio minus 'auto' (which create would render square). Dims at 1K. */
const flux3AspectRatios = [
  { label: '21:9', value: '21:9', width: 1536, height: 656 },
  { label: '2:1', value: '2:1', width: 1408, height: 704 },
  { label: '16:9', value: '16:9', width: 1360, height: 768 },
  { label: '3:2', value: '3:2', width: 1248, height: 832 },
  { label: '7:5', value: '7:5', width: 1184, height: 848 },
  { label: '4:3', value: '4:3', width: 1152, height: 864 },
  { label: '5:4', value: '5:4', width: 1120, height: 896 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 896, height: 1120 },
  { label: '3:4', value: '3:4', width: 864, height: 1152 },
  { label: '5:7', value: '5:7', width: 848, height: 1184 },
  { label: '2:3', value: '2:3', width: 832, height: 1248 },
  { label: '9:16', value: '9:16', width: 768, height: 1360 },
  { label: '1:2', value: '1:2', width: 704, height: 1408 },
];

const flux3PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// `768sq` is left out: it fixes a square output, which would fight the aspect-ratio picker.
export const flux3ResolutionOptions = ['1k', '2k', '4k'] as const;
type Flux3Resolution = (typeof flux3ResolutionOptions)[number];

// =============================================================================
// Flux.3 Graph
// =============================================================================

export const flux3Graph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        modelLocked: true,
        defaultModelId: flux3VersionId,
      }),
    []
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node('resolution', {
    input: z.enum(flux3ResolutionOptions).optional(),
    output: z.enum(flux3ResolutionOptions),
    defaultValue: '1k' as Flux3Resolution,
    meta: {
      options: flux3ResolutionOptions.map((value) => ({ label: value.toUpperCase(), value })),
    },
  })
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({
        options: flux3AspectRatios,
        defaultValue: '1:1',
        priorityOptions: flux3PriorityRatios,
      }),
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ min: 1, max: 10 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // fal defaults expansion ON; we default it off so the prompt is sent as written.
  .node('enablePromptExpansion', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  });
