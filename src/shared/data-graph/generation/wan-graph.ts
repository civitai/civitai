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
 * - model: Wan version selector (image-aware: shows txt2vid or img2vid versions)
 * - seed: Optional seed for reproducibility
 * - prompt: Text prompt
 * - aspectRatio: Output aspect ratio (hidden when images present)
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
  enumNode,
  imagesNode,
  resourcesNode,
  createCheckpointGraph,
  type ResourceData,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Wan version definitions - single source of truth for versions, ecosystems, and models */
const wanVersionDefs = [
  {
    version: 'v2.1',
    label: 'Wan 2.1',
    ecosystems: {
      t2v: 'WanVideo14B_T2V',
      i2v: 'WanVideo14B_I2V_720p',
      // v2.1 has resolution-dependent I2V variants
      i2v_480p: 'WanVideo14B_I2V_480p',
    },
    // Extra ecosystem keys that also map to this version (root WanVideo)
    extraEcosystems: ['WanVideo'] as string[],
  },
  {
    version: 'v2.2',
    label: 'Wan 2.2',
    ecosystems: {
      t2v: 'WanVideo-22-T2V-A14B',
      i2v: 'WanVideo-22-I2V-A14B',
    },
  },
  {
    version: 'v2.2-5b',
    label: 'Wan 2.2 5B',
    ecosystems: {
      t2v: 'WanVideo-22-TI2V-5B',
      i2v: 'WanVideo-22-TI2V-5B',
    },
  },
  {
    version: 'v2.5',
    label: 'Wan 2.5',
    ecosystems: {
      t2v: 'WanVideo-25-T2V',
      i2v: 'WanVideo-25-I2V',
    },
  },
] as const;

/** Wan version type */
type WanVersion = (typeof wanVersionDefs)[number]['version'];

/** Wan version options for the version picker (derived from wanVersionDefs) */
const wanVersionOptions = wanVersionDefs.map((d) => ({ label: d.label, value: d.version }));

/** Reverse lookup: ecosystem key → Wan version def */
const ecosystemToVersionDef = new Map(
  wanVersionDefs.flatMap((def) => {
    const entries: [string, typeof def][] = Object.values(def.ecosystems).map((eco) => [eco, def]);
    if ('extraEcosystems' in def) {
      for (const eco of def.extraEcosystems) entries.push([eco, def]);
    }
    return entries;
  })
);

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

/** Image entry type — must match ecosystem-graph's images node output */
type ImageEntry = { url: string; width: number; height: number };

/** Base context for version subgraphs */
type WanVersionCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData | undefined;
  wanVersion: WanVersion;
  images?: ImageEntry[];
};

/**
 * Wan 2.1 subgraph - basic controls with resolution selection
 *
 * For img2vid workflow, resolution picker controls the model variant:
 * - 480p → model ID 1501125 (Wan Video 14B i2v 480p)
 * - 720p → model ID 1501344 (Wan Video 14B I2V 720p)
 */
const wan21Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wan21AspectRatios, defaultValue: '1:1' }),
      when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
    }),
    ['images']
  )
  .node('resolution', {
    input: z.enum(['480p', '720p']).optional(),
    output: z.enum(['480p', '720p']),
    defaultValue: '480p' as const,
    meta: { options: wan21Resolutions },
  })
  .node('duration', enumNode({ options: wanDurations, defaultValue: 5 }))
  .node(
    'resources',
    (ctx) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: 2, // Fal provider has 2 max resources
      }),
    ['ecosystem']
  )
  // Effect: Sync I2V ecosystem based on resolution when in img2vid mode.
  // T2V switching is handled by the parent wanGraph effect.
  // Only sets ecosystem — model resets to correct default via discriminator switch.
  .effect(
    (ctx, _ext, set) => {
      if (ctx.workflow !== 'img2vid') return;

      // img2vid → ensure correct I2V ecosystem for current resolution
      const v21 = wanVersionDefs[0];
      const resolution = ctx.resolution as '480p' | '720p';
      const targetEco = resolution === '480p' ? v21.ecosystems.i2v_480p : v21.ecosystems.i2v;

      if (ctx.ecosystem !== targetEco) {
        set('ecosystem', targetEco);
      }
    },
    ['resolution', 'workflow']
  );

/**
 * Wan 2.2 subgraph - advanced controls with negative prompt, shift, interpolation
 */
const wan22Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wanAspectRatios, defaultValue: '1:1' }),
      when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
    }),
    ['images']
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
        ecosystem: ctx.ecosystem,
        limit: 2,
      }),
    ['ecosystem']
  );

/**
 * Wan 2.2-5b subgraph - smaller model with draft mode
 */
const wan225bGraph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wanAspectRatios, defaultValue: '1:1' }),
      when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
    }),
    ['images']
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
        ecosystem: ctx.ecosystem,
        limit: 2,
      }),
    ['ecosystem']
  );

/**
 * Wan 2.5 subgraph - latest version with extended durations
 */
const wan25Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: wanAspectRatios, defaultValue: '1:1' }),
      when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
    }),
    ['images']
  )
  .node('negativePrompt', negativePromptNode())
  .node('resolution', {
    input: z.enum(['480p', '720p', '1080p']).optional(),
    output: z.enum(['480p', '720p', '1080p']),
    defaultValue: '480p' as const,
    meta: { options: wan25Resolutions },
  })
  .node('duration', enumNode({ options: wan25Durations, defaultValue: 5 }))
  .node(
    'resources',
    (ctx) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: 2,
      }),
    ['ecosystem']
  );

// =============================================================================
// Wan Graph
// =============================================================================

/** Context shape for wan graph */
type WanCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData | undefined;
};

/**
 * Wan video generation controls.
 *
 * Version picker (wanVersion) shows Wan 2.1/2.2/2.2-5b/2.5 regardless of workflow.
 *
 * Ecosystem syncing is driven by workflow (txt2vid ↔ img2vid):
 * - Workflow effect: Handles T2V switching for ALL versions, I2V switching for v2.2+
 * - wan21Graph effect: Handles v2.1 I2V switching only (resolution-dependent: 480p/720p variants)
 *
 * v2.1 I2V is special because it has two ecosystems (480p and 720p) — the resolution
 * picker determines which one to use, so the subgraph must handle the I2V direction.
 */
export const wanGraph = new DataGraph<WanCtx, GenerationCtx>()
  // Images node - shown for img2vid, hidden for txt2vid.
  // When images are added, Effect A switches to the I2V ecosystem variant.
  .node(
    'images',
    (ctx) => ({
      ...imagesNode(),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // Merge checkpoint graph (model locked from ecosystem defaults)
  .merge(createCheckpointGraph())

  // Wan version - computed from ecosystem (the UI sets ecosystem directly)
  .computed('wanVersion', (ctx) => ecosystemToVersionDef.get(ctx.ecosystem)?.version ?? 'v2.1', [
    'ecosystem',
  ])

  // Effect: Sync ecosystem when workflow changes (T2V ↔ I2V)
  // Handles T2V direction for ALL versions (including v2.1).
  // I2V direction for v2.1 is handled by wan21Graph (resolution-dependent: 480p/720p variants).
  // Only sets ecosystem — model resets to correct default via discriminator switch.
  .effect(
    (ctx, _ext, set) => {
      const def = ecosystemToVersionDef.get(ctx.ecosystem);
      if (!def) return;

      const isImg2vid = ctx.workflow === 'img2vid';

      if (def.version === 'v2.1') {
        // v2.1: Only handle T2V here. I2V needs resolution (wan21Graph handles it).
        if (!isImg2vid) {
          const v21 = wanVersionDefs[0];
          if (ctx.ecosystem === v21.ecosystems.i2v || ctx.ecosystem === v21.ecosystems.i2v_480p) {
            set('ecosystem', v21.ecosystems.t2v);
          }
        }
        return;
      }

      const targetEco = isImg2vid ? def.ecosystems.i2v : def.ecosystems.t2v;

      if (ctx.ecosystem !== targetEco) {
        set('ecosystem', targetEco);
      }
    },
    ['workflow']
  )

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
  .discriminator('wanVersion', {
    'v2.1': wan21Graph,
    'v2.2': wan22Graph,
    'v2.2-5b': wan225bGraph,
    'v2.5': wan25Graph,
  });

// Export constants for use in components
export {
  wanVersionDefs,
  wanVersionOptions,
  ecosystemToVersionDef,
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
