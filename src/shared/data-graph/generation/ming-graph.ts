import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import { mingAspectRatios, mingResolutions } from '~/shared/constants/ming.constants';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  imagesNode,
  negativePromptGraph,
  createTextEditorGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';

// The locked default version comes from `ecosystemSettings` rather than an argument here, so the
// id the picker shows and the AIR the handler bills against cannot drift apart.
export const mingGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(createCheckpointGraph())
  .merge(createResourcesGraph({ resourceTypes: ['LORA'] }))
  .node('resolution', {
    input: z.enum(mingResolutions).optional(),
    output: z.enum(mingResolutions),
    defaultValue: '1K',
    meta: { options: mingResolutions.map((value) => ({ label: value, value })) },
  })
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: mingAspectRatios[ctx.resolution], defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2img',
    }),
    ['resolution', 'workflow']
  )
  .node(
    'images',
    (ctx) => ({ ...imagesNode({ min: 1, max: 3 }), when: ctx.workflow === 'img2img:edit' }),
    ['workflow']
  )
  .node('cfgScale', sliderNode({ min: 0, max: 30, defaultValue: 1, step: 0.5 }))
  .node('steps', sliderNode({ min: 1, max: 150, defaultValue: 12 }))
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(createTextEditorGraph({ name: 'prompt', required: true }))
  .merge(negativePromptGraph)
  .node('seed', seedNode());
