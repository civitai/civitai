/**
 * Wan Graph
 *
 * Controls for Wan video generation ecosystem.
 * Supports txt2vid and img2vid workflows across multiple versions (v2.1, v2.2, v2.2-5b, v2.5).
 *
 * Version-specific behavior:
 * - v2.1: Basic controls, supports LoRAs on Civitai provider
 * - v2.2: Advanced controls with negative prompt, shift, interpolation
 * - v2.2-5b: Smaller model with draft mode option
 * - v2.5: Latest version with extended duration options
 *
 * Nodes:
 * - version: Wan version selector
 * - seed: Optional seed for reproducibility
 * - prompt: Text prompt
 * - aspectRatio: Output aspect ratio (txt2vid only)
 * - cfgScale: CFG scale for generation control
 * - resolution: Output resolution
 * - resources: Additional LoRAs (version-dependent)
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptNode,
  aspectRatioNode,
  cfgScaleNode,
  stepsNode,
  resourcesNode,
  createCheckpointGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Wan version options */
const wanVersions = ['v2.1', 'v2.2', 'v2.2-5b', 'v2.5'] as const;
type WanVersion = (typeof wanVersions)[number];

const wanVersionOptions = [
  { label: 'Wan 2.1', value: 'v2.1' },
  { label: 'Wan 2.2', value: 'v2.2' },
  { label: 'Wan 2.2 5B', value: 'v2.2-5b' },
  { label: 'Wan 2.5', value: 'v2.5' },
];

/** Wan aspect ratio options */
const wanAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

/** Wan 2.1 aspect ratios (more options for Civitai provider) */
const wan21AspectRatios = [
  { label: '16:9', value: '16:9', width: 848, height: 480 },
  { label: '3:2', value: '3:2', width: 720, height: 480 },
  { label: '1:1', value: '1:1', width: 480, height: 480 },
  { label: '2:3', value: '2:3', width: 480, height: 720 },
  { label: '9:16', value: '9:16', width: 480, height: 848 },
];

/** Wan resolution options by version */
const wan21Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
];

const wan22Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
];

const wan225bResolutions = [
  { label: '580p', value: '580p' },
  { label: '720p', value: '720p' },
];

const wan25Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

/** Wan duration options */
const wanDurations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
];

const wan25Durations = [
  { label: '5 seconds', value: 5 },
  { label: '10 seconds', value: 10 },
];

/** Wan interpolator models (v2.2 only) */
const wanInterpolatorModels = [
  { label: 'None', value: 'none' },
  { label: 'FILM', value: 'film' },
  { label: 'RIFE', value: 'rife' },
];

// =============================================================================
// Version-specific Subgraphs
// =============================================================================

/** Base context for version subgraphs */
type WanVersionCtx = {
  baseModel: string;
  workflow: string;
  version: WanVersion;
};

/**
 * Wan 2.1 subgraph - basic controls with resolution selection
 */
const wan21Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wan21AspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )
  .node('resolution', {
    input: z.enum(['480p', '720p']).optional(),
    output: z.enum(['480p', '720p']),
    defaultValue: '480p' as const,
    meta: { options: wan21Resolutions },
  })
  .node('duration', {
    input: z.coerce.number().optional(),
    output: z.number(),
    defaultValue: 5,
    meta: { options: wanDurations },
  })
  .node(
    'resources',
    (ctx) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: 2, // Fal provider has 2 max resources
      }),
    ['baseModel']
  );

/**
 * Wan 2.2 subgraph - advanced controls with negative prompt, shift, interpolation
 */
const wan22Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wanAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )
  .node('negativePrompt', negativePromptNode())
  .node('resolution', {
    input: z.enum(['480p', '720p']).optional(),
    output: z.enum(['480p', '720p']),
    defaultValue: '480p' as const,
    meta: { options: wan22Resolutions },
  })
  .node('shift', {
    input: z.coerce.number().min(1).max(20).optional(),
    output: z.number().min(1).max(20),
    defaultValue: 8,
    meta: { min: 1, max: 20, step: 1 },
  })
  .node('interpolatorModel', {
    input: z.enum(['none', 'film', 'rife']).optional(),
    output: z.enum(['none', 'film', 'rife']),
    defaultValue: 'none' as const,
    meta: { options: wanInterpolatorModels },
  })
  .node('useTurbo', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node(
    'resources',
    (ctx) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: 2,
      }),
    ['baseModel']
  );

/**
 * Wan 2.2-5b subgraph - smaller model with draft mode
 */
const wan225bGraph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wanAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )
  .node('negativePrompt', negativePromptNode())
  .node('resolution', {
    input: z.enum(['580p', '720p']).optional(),
    output: z.enum(['580p', '720p']),
    defaultValue: '580p' as const,
    meta: { options: wan225bResolutions },
  })
  .node('draft', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('steps', stepsNode({ min: 20, max: 60, defaultValue: 40 }))
  .node('shift', {
    input: z.coerce.number().min(1).max(20).optional(),
    output: z.number().min(1).max(20),
    defaultValue: 8,
    meta: { min: 1, max: 20, step: 1 },
  })
  .node(
    'resources',
    (ctx) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: 2,
      }),
    ['baseModel']
  );

/**
 * Wan 2.5 subgraph - latest version with extended durations
 */
const wan25Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wanAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )
  .node('negativePrompt', negativePromptNode())
  .node('resolution', {
    input: z.enum(['480p', '720p', '1080p']).optional(),
    output: z.enum(['480p', '720p', '1080p']),
    defaultValue: '480p' as const,
    meta: { options: wan25Resolutions },
  })
  .node('duration', {
    input: z.coerce.number().optional(),
    output: z.number(),
    defaultValue: 5,
    meta: { options: wan25Durations },
  })
  .node(
    'resources',
    (ctx) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        limit: 2,
      }),
    ['baseModel']
  );

// =============================================================================
// Wan Graph
// =============================================================================

/** Context shape for wan graph */
type WanCtx = { baseModel: string; workflow: string };

/**
 * Wan video generation controls.
 *
 * Uses discriminator on 'version' to select version-specific controls.
 */
export const wanGraph = new DataGraph<WanCtx, GenerationCtx>()
  // Merge checkpoint graph (model node with locked model from ecosystem settings)
  .merge(createCheckpointGraph())

  // Version selector node
  .node('version', {
    input: z.enum(wanVersions).optional(),
    output: z.enum(wanVersions),
    defaultValue: 'v2.1' as WanVersion,
    meta: { options: wanVersionOptions },
  })

  // Seed node (common to all versions)
  .node('seed', seedNode())

  // CFG scale (common to all versions)
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 3.5,
      presets: [
        { label: 'Low', value: 2 },
        { label: 'Balanced', value: 3.5 },
        { label: 'High', value: 6 },
      ],
    })
  )

  // Version-specific controls via discriminator
  .discriminator('version', {
    'v2.1': wan21Graph,
    'v2.2': wan22Graph,
    'v2.2-5b': wan225bGraph,
    'v2.5': wan25Graph,
  });

// Export constants for use in components
export {
  wanVersions,
  wanVersionOptions,
  wanAspectRatios,
  wan21AspectRatios,
  wan21Resolutions,
  wan22Resolutions,
  wan225bResolutions,
  wan25Resolutions,
  wanDurations,
  wan25Durations,
  wanInterpolatorModels,
};
