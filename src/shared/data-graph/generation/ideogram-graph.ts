/**
 * Ideogram family: 4.0 (comfy, Civitai-hosted weights) and 4.5 (fal, API-only) share one
 * ecosystem, picked by model version. 4.0 has no negative prompt, sampler or scheduler —
 * ComfyIdeogram4CreateImageGenInput takes none. 4.5 edit: the first image is the source, the
 * rest references.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  sdxlFullAspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  imagesNode,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
  type ResourceData,
} from './common';

// =============================================================================
// Version Constants
// =============================================================================

export type IdeogramVersion = 'v4.0' | 'v4.5';

/** CivitaiOfficial model version ids. */
export const ideogramVersionIds = {
  'v4.0': 3246186,
  'v4.5': 3375798,
} as const;

const versionIdToIdeogramVersion = new Map<number, IdeogramVersion>(
  Object.entries(ideogramVersionIds).map(([v, id]) => [id, v as IdeogramVersion])
);

const ideogramTxt2ImgVersionOptions = [
  { label: 'v4.0', value: ideogramVersionIds['v4.0'] },
  { label: 'v4.5', value: ideogramVersionIds['v4.5'] },
];

const ideogramImg2ImgVersionOptions = [{ label: 'v4.5', value: ideogramVersionIds['v4.5'] }];

const ideogramWorkflowVersions = {
  txt2img: {
    versions: { options: ideogramTxt2ImgVersionOptions },
    defaultModelId: ideogramVersionIds['v4.0'],
  },
  'img2img:edit': {
    versions: { options: ideogramImg2ImgVersionOptions },
    defaultModelId: ideogramVersionIds['v4.5'],
  },
};

// =============================================================================
// Ideogram 4.5 Constants
// =============================================================================

/** fal accepts only an explicit list of custom sizes; these are its ~4MP entries. */
const ideogram45AspectRatios = [
  { label: '21:9', value: '21:9', width: 3072, height: 1280 },
  { label: '16:9', value: '16:9', width: 2560, height: 1440 },
  { label: '3:2', value: '3:2', width: 2496, height: 1664 },
  { label: '4:3', value: '4:3', width: 2304, height: 1728 },
  { label: '5:4', value: '5:4', width: 2240, height: 1792 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '4:5', value: '4:5', width: 1792, height: 2240 },
  { label: '3:4', value: '3:4', width: 1728, height: 2304 },
  { label: '2:3', value: '2:3', width: 1664, height: 2496 },
  { label: '9:16', value: '9:16', width: 1440, height: 2560 },
  { label: '9:21', value: '9:21', width: 1280, height: 3072 },
];

const ideogram45PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const ideogram45QualityOptions = ['high', 'medium', 'low'] as const;
type Ideogram45Quality = (typeof ideogram45QualityOptions)[number];

// =============================================================================
// Version Subgraphs
// =============================================================================

type IdeogramVersionCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData | undefined;
  ideogramVersion: IdeogramVersion;
};

const ideogram4Graph = new DataGraph<IdeogramVersionCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .node('aspectRatio', sdxlFullAspectRatioNode())
  .node('cfgScale', sliderNode({ min: 1, max: 10, defaultValue: 4, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 25 }));

const ideogram45Graph = new DataGraph<IdeogramVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({
        options: ideogram45AspectRatios,
        defaultValue: '1:1',
        priorityOptions: ideogram45PriorityRatios,
      }),
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ min: 1, max: 4 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node('quality', {
    input: z.enum(ideogram45QualityOptions).optional(),
    output: z.enum(ideogram45QualityOptions),
    defaultValue: 'medium' as Ideogram45Quality,
    meta: {
      options: ideogram45QualityOptions.map((q) => ({
        label: q.charAt(0).toUpperCase() + q.slice(1),
        value: q,
      })),
    },
  })
  // fal defaults expansion ON; we default it off so the prompt is sent as written.
  .node(
    'enablePromptExpansion',
    (ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  );

// =============================================================================
// Ideogram Family Graph
// =============================================================================

export const ideogramGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData | undefined },
  GenerationCtx
>()
  .merge(
    (ctx) =>
      createCheckpointGraph({
        workflowVersions: ideogramWorkflowVersions,
        currentWorkflow: ctx.workflow,
      }),
    ['workflow']
  )
  .computed(
    'ideogramVersion',
    (ctx): IdeogramVersion =>
      (ctx.model?.id && versionIdToIdeogramVersion.get(ctx.model.id)) || 'v4.0',
    ['model']
  )
  .discriminator('ideogramVersion', {
    'v4.0': ideogram4Graph,
    'v4.5': ideogram45Graph,
  })
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node('seed', seedNode());
