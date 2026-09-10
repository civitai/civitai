/**
 * Video Preprocess Graph
 *
 * Graph for the control-preprocessor workflow (vid2vid:preprocess) — the video
 * counterpart to `image-preprocess-graph.ts`. Standalone workflow, no ecosystem.
 * Mirrors `PreprocessVideoInput`: one `kind` picks the preprocessor, plus a
 * free-form `kindParams` record for kind-specific options, merged by the handler.
 *
 * The orchestrator implements only five kinds for video, against ~37 for image.
 * Each one's parameters are identical to its image counterpart, so the specs are
 * derived from `preprocessKindParamSpecs` rather than restated.
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { sliderNode, videoNode } from './common';
import { preprocessKindParamSpecs, type ParamSpec } from './image-preprocess-graph';
import {
  videoControlNetPreprocessors,
  controlNetToPreprocessVideoKind,
} from '~/shared/constants/controlnets.constants';

/**
 * Kinds `PreprocessVideoInput` implements, derived from the ControlNet key list
 * so the standalone workflow and the H3 ControlNet picker can never disagree
 * about what the orchestrator supports.
 */
export const videoPreprocessKinds = videoControlNetPreprocessors.map(
  (key) => controlNetToPreprocessVideoKind[key]
) as [string, ...string[]];

export type VideoPreprocessKind = (typeof videoPreprocessKinds)[number];

export const videoPreprocessKindParamSpecs: Record<string, readonly ParamSpec[]> =
  Object.fromEntries(
    videoPreprocessKinds.map((kind) => [
      kind,
      preprocessKindParamSpecs[kind as keyof typeof preprocessKindParamSpecs] ?? [],
    ])
  );

const kindParamsSchema = z.record(z.string(), z.unknown());

export const videoPreprocessGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  .node('video', () => videoNode(), [])
  .node(
    'preprocessKind',
    () => ({
      input: z.enum(videoPreprocessKinds).optional(),
      output: z.enum(videoPreprocessKinds),
      defaultValue: videoPreprocessKinds[0],
      meta: { options: videoPreprocessKinds.map((value) => ({ label: value, value })) },
    }),
    []
  )
  // Sets the shorter edge; the same bounds as the image workflow, since
  // `PreprocessVideoInput` declares no range of its own.
  .node(
    'preprocessResolution',
    () => sliderNode({ min: 64, max: 2048, step: 8, defaultValue: 512 }),
    []
  )
  .node(
    'kindParams',
    (ctx) => ({
      input: kindParamsSchema.optional(),
      output: kindParamsSchema,
      defaultValue: {} as Record<string, unknown>,
      meta: {
        specs: ctx.preprocessKind ? videoPreprocessKindParamSpecs[ctx.preprocessKind] ?? [] : [],
      },
    }),
    ['preprocessKind']
  );

export type VideoPreprocessGraphCtx = ReturnType<typeof videoPreprocessGraph.init>;
