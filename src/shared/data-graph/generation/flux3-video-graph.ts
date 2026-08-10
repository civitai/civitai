/**
 * Flux 3 Video Graph
 *
 * Controls for Black Forest Labs' FLUX-3 Video ecosystem (engine: `flux`,
 * version `v3.0`), served via FAL.
 *
 * Workflows:
 * - txt2vid: prompt only (`textToVideo`)
 * - img2vid: first frame alone runs `imageToVideo`; adding the optional last
 *   frame promotes the step to `firstLastFrameToVideo`
 *
 * `keyframesToVideo`, `extendVideo` and `draftEnhance` exist on the API but are
 * not surfaced yet.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  enumNode,
  imagesNode,
  promptGraph,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { flux3VideoVersionIds } from './version-ids';

export { flux3VideoVersionIds };

/**
 * The API also accepts `2:1`, which has no entry in the shared
 * `aspectRatioDimensions` table — omitted rather than inventing dimensions for
 * every resolution tier.
 */
const flux3VideoAspectRatioList: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
];

const flux3VideoResolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

export const flux3VideoGraph = new DataGraph<
  { ecosystem: string; workflow: string },
  GenerationCtx
>()
  // img2vid carries both frames: supplying only the first runs imageToVideo,
  // adding the second promotes the step to firstLastFrameToVideo. Matches how
  // Vidu and MiniMax expose first/last, rather than a separate workflow entry.
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({
        slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
        warnOnMissingAiMetadata: true,
      }),
      when: isWorkflowOrVariant(ctx.workflow, 'img2vid'),
    }),
    ['workflow']
  )
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: [{ label: 'v3.0', value: flux3VideoVersionIds['v3.0'] }] },
        defaultModelId: flux3VideoVersionIds['v3.0'],
      }),
    []
  )
  // Draft renders at 720p regardless, so the resolution control only matters for
  // full-quality runs.
  .node(
    'resolution',
    (ctx) => ({
      ...enumNode({ options: flux3VideoResolutions, defaultValue: '720p' }),
      when: !('draft' in ctx) || ctx.draft !== true,
    }),
    ['draft']
  )
  // Image-driven operations take their framing from the source image, so the
  // handler sends `auto` and the control is hidden.
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = 'resolution' in ctx ? (ctx.resolution as string) : '720p';
      return {
        ...aspectRatioNode({
          options: getAspectRatioOptions(resolution, flux3VideoAspectRatioList),
          defaultValue: '16:9',
        }),
        when: ctx.workflow === 'txt2vid',
      };
    },
    ['workflow', 'resolution']
  )
  .node('duration', sliderNode({ min: 4, max: 20, defaultValue: 5 }))
  .node(
    'generateAudio',
    () => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
    }),
    []
  )
  .node(
    'draft',
    () => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
    }),
    []
  )

  // Prompt + triggerWords (no negativePrompt for Flux 3 Video)
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

export { flux3VideoAspectRatioList, flux3VideoResolutions };
