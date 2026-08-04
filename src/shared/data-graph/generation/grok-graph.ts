/**
 * Grok Graph
 *
 * Controls for Grok ecosystem (xAI Grok Imagine).
 * Supports both image and video generation workflows.
 *
 * Version-selectable (v1.0 / v1.5) via the model picker. Image generation is
 * version-less on the API, so the image workflows are v1.0-only and excluded for
 * v1.5 in config/workflows.ts.
 *
 * Image workflows (v1.0 only):
 * - txt2img: Create image from text (GrokCreateImageGenInput)
 * - img2img:edit: Edit image with AI (GrokEditImageGenInput)
 *
 * Video workflows:
 * - txt2vid          → 'text-to-video' (v1.0) / 'textToVideo' (v1.5)
 * - img2vid          → 'image-to-video' (v1.0) / 'imageToVideo' (v1.5)
 * - img2vid:ref2vid  → 'referenceToVideo' (v1.5 only, 1-7 reference images)
 * - vid2vid:edit     → 'edit-video' (v1.0 only)
 *
 * Uses a discriminator on the parent's `output` node ('image' | 'video')
 * to split into image-specific and video-specific subgraphs.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  aspectRatioNode,
  createTextEditorGraph,
  enumNode,
  imagesNode,
  snippetsGraph,
  triggerWordsGraph,
  videoNode,
  createCheckpointGraph,
} from './common';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { grokVersionIds } from './version-ids';

// =============================================================================
// Constants
// =============================================================================

/** Grok aspect ratios for image workflows */
const grokImageAspectRatios = [
  { label: '16:9', value: '16:9', width: 1824, height: 1024 },
  { label: '3:2', value: '3:2', width: 1536, height: 1024 },
  { label: '4:3', value: '4:3', width: 1184, height: 888 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 888, height: 1184 },
  { label: '2:3', value: '2:3', width: 1024, height: 1536 },
  { label: '9:16', value: '9:16', width: 1024, height: 1824 },
];

const grokVideoAspectRatioList: GenerationAspectRatio[] = [
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
];

/** Grok video aspect ratios keyed by resolution — used by the handler to snap inputs */
const grokVideoAspectRatiosByResolution: Record<
  string,
  ReturnType<typeof getAspectRatioOptions>
> = {
  '480p': getAspectRatioOptions('480p', grokVideoAspectRatioList),
  '720p': getAspectRatioOptions('720p', grokVideoAspectRatioList),
};

/** Grok video resolution options */
const grokResolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
] as const;

/** v1.5 text-to-video and image-to-video additionally accept 1080p */
const grokV15Resolutions = [...grokResolutions, { label: '1080p', value: '1080p' }] as const;

/** Options for the Grok version selector (using version IDs as values) */
const grokVersionOptions = [
  { label: 'v1.0', value: grokVersionIds['v1.0'] },
  { label: 'v1.5', value: grokVersionIds['v1.5'] },
];

/** True when the selected model version is Grok Imagine v1.5 */
const isGrokV15 = (modelId?: number) => modelId === grokVersionIds['v1.5'];

// =============================================================================
// Image Subgraph
// =============================================================================

type ImageEntry = { url: string; width: number; height: number };

type GrokImageCtx = {
  ecosystem: string;
  workflow: string;
  output: 'image';
  images?: ImageEntry[];
};

const grokImageGraph = new DataGraph<GrokImageCtx, GenerationCtx>()
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 7 }),
      when: ctx.workflow === 'img2img:edit',
    }),
    ['workflow']
  )
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: grokImageAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow !== 'img2img:edit',
    }),
    ['workflow']
  );

// =============================================================================
// Video Subgraph
// =============================================================================

type GrokVideoCtx = {
  ecosystem: string;
  workflow: string;
  output: 'video';
  model?: { id: number };
  images?: ImageEntry[];
  video?: { url: string; metadata?: { duration?: number } };
};

const grokVideoGraph = new DataGraph<GrokVideoCtx, GenerationCtx>()
  .node(
    'video',
    (ctx) => ({
      ...videoNode(),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )
  .node(
    'images',
    (ctx) => {
      if (ctx.workflow === 'img2vid:ref2vid')
        return { ...imagesNode({ max: 7, warnOnMissingAiMetadata: true }), when: true };
      return {
        ...imagesNode({ max: 1, warnOnMissingAiMetadata: true }),
        when: ctx.workflow === 'img2vid',
      };
    },
    ['workflow']
  )
  .node(
    'resolution',
    (ctx) => {
      const supports1080p = isGrokV15(ctx.model?.id) && ctx.workflow !== 'img2vid:ref2vid';
      return enumNode({
        options: supports1080p ? grokV15Resolutions : grokResolutions,
        defaultValue: '720p',
      });
    },
    ['workflow', 'model']
  )
  .node('duration', {
    input: z.coerce.number().min(6).max(15).optional(),
    output: z.number().min(6).max(15),
    defaultValue: 6,
    meta: { min: 6, max: 15, step: 1 },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const options = getAspectRatioOptions(
        (ctx as { resolution?: string }).resolution ?? '720p',
        grokVideoAspectRatioList
      );
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      const hasVideo = !!ctx.video?.url;
      // ref2vid takes an explicit ratio even though it has images; the other
      // image/video-driven workflows derive it from the input instead.
      const isRef2Vid = ctx.workflow === 'img2vid:ref2vid';
      return {
        ...aspectRatioNode({ options, defaultValue: '16:9' }),
        when: isRef2Vid || (!hasImages && !hasVideo),
      };
    },
    ['workflow', 'images', 'video', 'resolution']
  );

// =============================================================================
// Grok Graph
// =============================================================================

/** Context shape for grok graph */
type GrokCtx = {
  ecosystem: string;
  workflow: string;
  output: 'image' | 'video';
  model?: { id: number };
};

/**
 * Grok generation controls.
 *
 * Supports both image and video workflows from a single ecosystem.
 * Uses a discriminator on the parent's `output` node to split into image/video subgraphs.
 */
export const grokGraph = new DataGraph<GrokCtx, GenerationCtx>()
  // Version-locked model (v1.0 / v1.5) — swap button hidden via modelLocked in
  // ecosystemSettings; the default model id comes from ecosystemSettings.
  .merge(() => createCheckpointGraph({ versions: { options: grokVersionOptions } }), [])

  // Seed node
  .node('seed', seedNode())

  // Discriminator: image vs video subgraphs (uses parent's `output` computed node)
  .discriminator('output', {
    image: grokImageGraph,
    video: grokVideoGraph,
  })

  // Prompt + triggerWords — Grok is text-driven across both image and video
  // workflows, so prompt is always required (no negativePrompt for Grok).
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(createTextEditorGraph({ name: 'prompt', required: true }));

// Export constants for use in components
export {
  grokImageAspectRatios,
  grokVideoAspectRatiosByResolution,
  grokResolutions,
  grokV15Resolutions,
  isGrokV15,
};
