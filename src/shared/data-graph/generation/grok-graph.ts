/**
 * Grok Graph
 *
 * Controls for Grok ecosystem (xAI Grok Imagine).
 * Supports both image and video generation workflows.
 *
 * Image workflows:
 * - txt2img: Create image from text (GrokCreateImageGenInput)
 * - img2img:edit: Edit image with AI (GrokEditImageGenInput)
 *
 * Video workflows:
 * - txt2vid: Text to video (GrokTextToVideoInput)
 * - img2vid: Image to video (GrokImageToVideoInput)
 * - vid2vid:edit: Edit video with AI (GrokEditVideoInput)
 *
 * Uses a discriminator on the parent's `output` node ('image' | 'video')
 * to split into image-specific and video-specific subgraphs.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, aspectRatioNode, imagesNode, videoNode, createCheckpointGraph } from './common';

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

/** Grok video aspect ratios by resolution */
const grokVideoAspectRatiosByResolution: Record<string, typeof grokImageAspectRatios> = {
  '480p': [
    { label: '16:9', value: '16:9', width: 848, height: 480 },
    { label: '3:2', value: '3:2', width: 720, height: 480 },
    { label: '4:3', value: '4:3', width: 640, height: 480 },
    { label: '1:1', value: '1:1', width: 480, height: 480 },
    { label: '3:4', value: '3:4', width: 480, height: 640 },
    { label: '2:3', value: '2:3', width: 480, height: 720 },
    { label: '9:16', value: '9:16', width: 480, height: 848 },
  ],
  '720p': [
    { label: '16:9', value: '16:9', width: 1280, height: 720 },
    { label: '3:2', value: '3:2', width: 1080, height: 720 },
    { label: '4:3', value: '4:3', width: 960, height: 720 },
    { label: '1:1', value: '1:1', width: 720, height: 720 },
    { label: '3:4', value: '3:4', width: 720, height: 960 },
    { label: '2:3', value: '2:3', width: 720, height: 1080 },
    { label: '9:16', value: '9:16', width: 720, height: 1280 },
  ],
};

/** Grok video resolution options */
const grokResolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
];

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
  .node('aspectRatio', aspectRatioNode({ options: grokImageAspectRatios, defaultValue: '1:1' }));

// =============================================================================
// Video Subgraph
// =============================================================================

type GrokVideoCtx = {
  ecosystem: string;
  workflow: string;
  output: 'video';
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
    (ctx) => ({
      ...imagesNode({ max: 1, warnOnMissingAiMetadata: true }),
      when: ctx.workflow === 'img2vid',
    }),
    ['workflow']
  )
  .node('resolution', {
    input: z.enum(['480p', '720p']).optional(),
    output: z.enum(['480p', '720p']),
    defaultValue: '720p' as const,
    meta: { options: grokResolutions },
  })
  .node('duration', {
    input: z.coerce.number().min(6).max(15).optional(),
    output: z.number().min(6).max(15),
    defaultValue: 6,
    meta: { min: 6, max: 15, step: 1 },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '720p';
      const options =
        grokVideoAspectRatiosByResolution[resolution] ?? grokVideoAspectRatiosByResolution['720p'];
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      const hasVideo = !!ctx.video?.url;
      return {
        ...aspectRatioNode({ options, defaultValue: '16:9' }),
        when: !hasImages && !hasVideo,
      };
    },
    ['images', 'video', 'resolution']
  );

// =============================================================================
// Grok Graph
// =============================================================================

/** Context shape for grok graph */
type GrokCtx = { ecosystem: string; workflow: string; output: 'image' | 'video' };

/**
 * Grok generation controls.
 *
 * Supports both image and video workflows from a single ecosystem.
 * Uses a discriminator on the parent's `output` node to split into image/video subgraphs.
 */
export const grokGraph = new DataGraph<GrokCtx, GenerationCtx>()
  // Merge checkpoint graph (default model set via ecosystemSettings)
  .merge(() => createCheckpointGraph(), [])

  // Seed node
  .node('seed', seedNode())

  // Discriminator: image vs video subgraphs (uses parent's `output` computed node)
  .discriminator('output', {
    image: grokImageGraph,
    video: grokVideoGraph,
  });

// Export constants for use in components
export { grokImageAspectRatios, grokVideoAspectRatiosByResolution, grokResolutions };
