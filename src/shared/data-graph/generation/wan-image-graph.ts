/**
 * Wan Image Graph
 *
 * Controls for Wan image generation ecosystems.
 * Separate from the video graph (wan-graph.ts) to allow independent version selection.
 *
 * Currently supports:
 * - v2.7: txt2img and img2img:edit via fal provider
 *
 * Architecture mirrors the video graph pattern:
 * - wanImageVersionDefs: Single source of truth for versions and ecosystems
 * - Version discriminator routes to version-specific subgraphs
 * - Each subgraph defines version-specific controls
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptNode,
  aspectRatioNode,
  sliderNode,
  imagesNode,
  createCheckpointGraph,
  type ResourceData,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Wan image version definitions - single source of truth */
const wanImageVersionDefs = [
  {
    version: 'v2.7',
    label: '2.7',
    ecosystems: {
      t2i: 'WanImage27',
    },
  },
] as const;

/** Wan image version type */
type WanImageVersion = (typeof wanImageVersionDefs)[number]['version'];

/** Wan image version options for the version picker */
const wanImageVersionOptions = wanImageVersionDefs.map((d) => ({
  label: d.label,
  value: d.version,
}));

/** Reverse lookup: ecosystem key → Wan image version def */
const ecosystemToImageVersionDef = new Map(
  wanImageVersionDefs.flatMap((def) => {
    const entries: [string, typeof def][] = Object.values(def.ecosystems).map((eco) => [eco, def]);
    return entries;
  })
);

/** Wan 2.7 model version ID */
export const wan27VersionId = 2828170;

/** Wan 2.7 image aspect ratios (mapped to fal imageSize in handler) */
const wan27ImageAspectRatios = [
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:3', value: '4:3', width: 1024, height: 768 },
  { label: '3:4', value: '3:4', width: 768, height: 1024 },
  { label: '16:9', value: '16:9', width: 1024, height: 576 },
  { label: '9:16', value: '9:16', width: 576, height: 1024 },
];

// =============================================================================
// Wan 2.7 Subgraph
// =============================================================================

/** Image entry type — must match ecosystem-graph's images node output */
type ImageEntry = { url: string; width: number; height: number };

/** Base context for version subgraphs */
type WanImageVersionCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData | undefined;
  wanImageVersion: WanImageVersion;
  images?: ImageEntry[];
};

/**
 * Wan 2.7 subgraph - image generation controls
 *
 * Supports txt2img and img2img:edit workflows via fal provider.
 * Controls: negativePrompt, aspectRatio, enablePromptEnhancer
 */
const wan27Graph = new DataGraph<WanImageVersionCtx, GenerationCtx>()
  .node('negativePrompt', negativePromptNode({ maxLength: 500 }))
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wan27ImageAspectRatios, defaultValue: '1:1' }),
      when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
    }),
    ['images']
  )
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  });

// =============================================================================
// Wan Image Graph
// =============================================================================

/** Context shape for wan image graph */
type WanImageCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData | undefined;
};

/**
 * Wan image generation controls.
 *
 * Version picker (wanImageVersion) allows selecting between Wan image model versions.
 * Currently only v2.7, but extensible for future versions.
 */
export const wanImageGraph = new DataGraph<WanImageCtx, GenerationCtx>()
  // Images node - shown for img2img:edit, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ warnOnMissingAiMetadata: true, max: 5 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // Merge checkpoint graph (model locked from ecosystem defaults)
  .merge(createCheckpointGraph())

  // Wan image version - computed from ecosystem
  .computed(
    'wanImageVersion',
    (ctx) => ecosystemToImageVersionDef.get(ctx.ecosystem)?.version ?? 'v2.7',
    ['ecosystem']
  )

  // Seed node
  .node('seed', seedNode())

  // CFG scale / guidance scale
  .node(
    'cfgScale',
    sliderNode({
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
  .discriminator('wanImageVersion', {
    'v2.7': wan27Graph,
  });

// Export constants for use in components
export {
  wanImageVersionDefs,
  wanImageVersionOptions,
  ecosystemToImageVersionDef,
  wan27ImageAspectRatios,
};
