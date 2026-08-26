/**
 * Wan Graph
 *
 * One graph for every Wan version, branched on `wanVersion` via the discriminator
 * at the bottom. `wanVersionDefs` is the source of truth for which ecosystem keys
 * map to which version — add a version there and to the discriminator, not by
 * forking this file.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptGraph,
  negativePromptNode,
  promptGraph,
  snippetsGraph,
  triggerWordsGraph,
  aspectRatioNode,
  sliderNode,
  enumNode,
  imagesNode,
  videoNode,
  createResourcesGraph,
  createCheckpointGraph,
  type ResourceData,
} from './common';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';

// =============================================================================
// Constants
// =============================================================================

/** Wan version definitions - single source of truth for versions, ecosystems, and models */
const wanVersionDefs = [
  {
    version: 'v2.1',
    label: '2.1',
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
    label: '2.2',
    ecosystems: {
      t2v: 'WanVideo-22-T2V-A14B',
      i2v: 'WanVideo-22-I2V-A14B',
    },
  },
  {
    version: 'v2.2-5b',
    label: '2.2 5B',
    ecosystems: {
      t2v: 'WanVideo-22-TI2V-5B',
      i2v: 'WanVideo-22-TI2V-5B',
    },
  },
  {
    version: 'v2.5',
    label: '2.5',
    ecosystems: {
      t2v: 'WanVideo-25-T2V',
      i2v: 'WanVideo-25-I2V',
    },
  },
  {
    version: 'v2.7',
    label: '2.7',
    ecosystems: {
      t2v: 'WanVideo27',
      i2v: 'WanVideo27',
    },
  },
  {
    version: 'v3.0',
    label: '3.0',
    ecosystems: {
      t2v: 'WanVideo30',
      i2v: 'WanVideo30',
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

/** Wan aspect ratio options (basic 3 — used by v2.2-5b; 1024×1024 1:1 diverges from table) */
const wanAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

const wan22AspectRatioList: GenerationAspectRatio[] = [
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '5:4',
  '4:5',
];
const wan25AspectRatioList: GenerationAspectRatio[] = ['16:9', '1:1', '9:16'];
const wan21AspectRatioList: GenerationAspectRatio[] = ['16:9', '3:2', '1:1', '2:3', '9:16'];

/** Wan 2.2 aspect ratios at 720p (API supports 7 ratios) */
const wan22AspectRatios = getAspectRatioOptions('720p', wan22AspectRatioList);

/** Wan 2.2 multi-step aspect ratios by resolution */
const wan22MultiStepAspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '480p': getAspectRatioOptions('480p', wan22AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan22AspectRatioList),
};

/** Wan 2.5 resolution-dependent aspect ratios */
const wan25AspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '480p': getAspectRatioOptions('480p', wan25AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan25AspectRatioList),
  '1080p': getAspectRatioOptions('1080p', wan25AspectRatioList),
};

/** Wan 2.1 resolution-dependent aspect ratios */
const wan21AspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '480p': getAspectRatioOptions('480p', wan21AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan21AspectRatioList),
};

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

/** Wan interpolator models (v2.2 and v2.2-5b) */
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
  .node('resolution', {
    input: z.enum(['480p', '720p']).optional(),
    output: z.enum(['480p', '720p']),
    defaultValue: '480p' as const,
    meta: { options: wan21Resolutions },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '480p';
      const options =
        wan21AspectRatiosByResolution[resolution] ?? wan21AspectRatiosByResolution['480p'];
      return {
        ...aspectRatioNode({ options, defaultValue: '1:1' }),
        when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
      };
    },
    ['images', 'resolution']
  )
  .node('duration', enumNode({ options: wanDurations, defaultValue: 5 }))
  .merge(createResourcesGraph())
  // Prompt + triggerWords — wan2.1 has no negativePrompt
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
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
 * Wan 2.2 subgraph - advanced controls with negative prompt, shift, interpolation.
 *
 * Two modes, driven entirely by the `wan22MultiStep` flipt flag:
 * - Flag ON: 12fps comfy generation + VFIMamba interpolation. Exposes duration and
 *   expanded aspect ratios. Hides interpolatorModel and draft.
 * - Flag OFF: Single-step FAL generation. Exposes interpolatorModel and draft.
 */
const wan22Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('resolution', {
    input: z.enum(['480p', '720p']).optional(),
    output: z.enum(['480p', '720p']),
    defaultValue: '480p' as const,
    meta: { options: wan22Resolutions },
  })
  .node(
    'aspectRatio',
    (ctx, ext) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '480p';
      const multiStep = ext.flags?.wan22MultiStep ?? false;
      const options = multiStep
        ? wan22MultiStepAspectRatiosByResolution[resolution] ??
          wan22MultiStepAspectRatiosByResolution['480p']
        : wan25AspectRatiosByResolution[resolution] ?? wan25AspectRatiosByResolution['480p'];
      return {
        ...aspectRatioNode({ options, defaultValue: '1:1' }),
        when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
      };
    },
    ['images', 'resolution']
  )
  .node('shift', {
    input: z.coerce.number().min(1).max(20).optional(),
    output: z.number().min(1).max(20),
    defaultValue: 8,
    meta: { min: 1, max: 20, step: 1 },
  })
  // Multi-step only: duration
  .node(
    'duration',
    (_ctx, ext) => ({
      ...enumNode({ options: wanDurations, defaultValue: 5 }),
      when: ext.flags?.wan22MultiStep === true,
    }),
    []
  )
  // Legacy only: interpolatorModel and draft
  .node(
    'interpolatorModel',
    (_ctx, ext) => ({
      input: z.enum(['none', 'film', 'rife']).optional(),
      output: z.enum(['none', 'film', 'rife']),
      defaultValue: 'none' as const,
      meta: { options: wanInterpolatorModels },
      when: ext.flags?.wan22MultiStep !== true,
    }),
    []
  )
  .node(
    'draft',
    (_ctx, ext) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: ext.flags?.wan22MultiStep !== true,
    }),
    []
  )
  .merge(createResourcesGraph({ limit: 2 }));

/**
 * Wan 2.2-5b subgraph - smaller 5B model variant
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
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('resolution', {
    input: z.enum(['580p', '720p']).optional(),
    output: z.enum(['580p', '720p']),
    defaultValue: '580p' as const,
    meta: { options: wan225bResolutions },
  })
  .node('steps', sliderNode({ min: 20, max: 60, defaultValue: 40 }))
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
  .merge(createResourcesGraph({ limit: 2 }));

/**
 * Wan 2.5 subgraph - latest version with extended durations
 *
 * Resolution is defined before aspectRatio so that aspect ratio dimensions
 * can update based on the selected resolution (480p/720p/1080p).
 */
const wan25Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('resolution', {
    input: z.enum(['480p', '720p', '1080p']).optional(),
    output: z.enum(['480p', '720p', '1080p']),
    defaultValue: '480p' as const,
    meta: { options: wan25Resolutions },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '480p';
      const options =
        wan25AspectRatiosByResolution[resolution] ?? wan25AspectRatiosByResolution['480p'];
      return {
        ...aspectRatioNode({ options, defaultValue: '1:1' }),
        when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
      };
    },
    ['images', 'resolution']
  )
  .node('duration', enumNode({ options: wan25Durations, defaultValue: 5 }));

// =============================================================================
// Wan 2.7 Video Subgraph
// =============================================================================

const wan27AspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/** Wan 2.7 video aspect ratios by resolution */
const wan27AspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '720p': getAspectRatioOptions('720p', wan27AspectRatioList),
  '1080p': getAspectRatioOptions('1080p', wan27AspectRatioList),
};

/** Wan 2.7 video resolution options */
const wan27Resolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

/**
 * Wan 2.7 video subgraph
 *
 * Supports 4 workflows via fal provider:
 * - txt2vid: text-to-video (prompt, aspectRatio, duration 2-15, audioUrl)
 * - img2vid: image-to-video (startImage, endImage, videoUrl, duration 2-15, audioUrl)
 * - img2vid:ref2vid: reference-to-video (referenceImages, aspectRatio, duration 2-10, multiShots)
 * - vid2vid:edit: edit-video (videoUrl required, referenceImage, audioSetting, duration 0+2-10)
 *
 * Per the fal API spec: cfgScale, steps, frameRate, loras are NOT supported for v2.7.
 */
const wan27Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  // Video input for vid2vid:edit
  .node(
    'video',
    (ctx) => ({
      ...videoNode(),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )
  // Prompt + triggerWords + negativePrompt (negativePrompt supported on txt2vid,
  // img2vid, ref2vid — not on edit-video, hence the conditional `when`)
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node(
    'negativePrompt',
    (ctx) => ({
      ...negativePromptNode(),
      when: ctx.workflow !== 'vid2vid:edit',
    }),
    ['workflow']
  )
  .node('resolution', {
    input: z.enum(['720p', '1080p']).optional(),
    output: z.enum(['720p', '1080p']),
    defaultValue: '720p' as const,
    meta: { options: wan27Resolutions },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '720p';
      const options =
        wan27AspectRatiosByResolution[resolution] ?? wan27AspectRatiosByResolution['720p'];
      // Hide when images/video present (aspect ratio derived from source)
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      const hasVideo = !!(ctx as { video?: { url: string } }).video?.url;
      return {
        ...aspectRatioNode({ options, defaultValue: '16:9' }),
        when: !hasImages && !hasVideo,
      };
    },
    ['images', 'video', 'resolution']
  )
  // Duration slider - range depends on workflow (2-15 for txt2vid/img2vid, 2-10 for ref2vid/edit-video)
  .node(
    'duration',
    (ctx) => {
      const isRef2vid = ctx.workflow === 'img2vid:ref2vid';
      const isEditVideo = ctx.workflow === 'vid2vid:edit';
      const max = isRef2vid || isEditVideo ? 10 : 15;
      return {
        ...sliderNode({ min: 2, max, step: 1, defaultValue: 5 }),
        transform: (value: number) => Math.min(Math.max(value, 2), max),
      };
    },
    ['workflow']
  )
  // Enable prompt expansion (txt2vid and img2vid only — not on ref2vid or edit-video per spec)
  .node(
    'enablePromptEnhancer',
    (ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid',
    }),
    ['workflow']
  );

// =============================================================================
// Wan 3.0 Video Subgraph
// =============================================================================

const wan30AspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const wan30AspectRatiosByResolution: Record<string, typeof wanAspectRatios> = {
  '480p': getAspectRatioOptions('480p', wan30AspectRatioList),
  '720p': getAspectRatioOptions('720p', wan30AspectRatioList),
  '1080p': getAspectRatioOptions('1080p', wan30AspectRatioList),
};

const wan30Resolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

/**
 * Wan 3.0 video subgraph
 *
 * `usePrime` routes to wan3.0-video-prime — same output quality, lower latency,
 * higher price — so it is a cost decision the user has to make explicitly.
 */
const wan30Graph = new DataGraph<WanVersionCtx, GenerationCtx>()
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('resolution', {
    input: z.enum(['480p', '720p', '1080p']).optional(),
    output: z.enum(['480p', '720p', '1080p']),
    defaultValue: '720p' as const,
    meta: { options: wan30Resolutions },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '720p';
      const options =
        wan30AspectRatiosByResolution[resolution] ?? wan30AspectRatiosByResolution['720p'];
      return {
        ...aspectRatioNode({ options, defaultValue: '16:9' }),
        when: !(Array.isArray(ctx.images) && ctx.images.length > 0),
      };
    },
    ['images', 'resolution']
  )
  // Alibaba documents 2-30s for wan3.0-video, default 5.
  .node('duration', sliderNode({ min: 2, max: 30, step: 1, defaultValue: 5 }))
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('usePrime', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  });

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
  // Images node - shown for img2vid/ref2vid, hidden for txt2vid and vid2vid:edit.
  // v2.7 img2vid uses slots for first/last frame; ref2vid allows multiple reference images.
  .node(
    'images',
    (ctx) => {
      const version = ecosystemToVersionDef.get(ctx.ecosystem)?.version;
      const isV27 = version === 'v2.7';
      const isRef2vid = ctx.workflow === 'img2vid:ref2vid';
      const isImg2vid = ctx.workflow === 'img2vid' || ctx.workflow === 'img2vid:first-last';
      const isEditVideo = ctx.workflow.startsWith('vid2vid');

      // v3.0 takes startImage + optional endImage, same slot shape as v2.7.
      if ((isV27 || version === 'v3.0') && isImg2vid) {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
          }),
          when: true,
        };
      }

      if (isV27 && isRef2vid) {
        return {
          ...imagesNode({ warnOnMissingAiMetadata: true, max: 5 }),
          when: true,
        };
      }

      return {
        ...imagesNode({ warnOnMissingAiMetadata: true }),
        when: !ctx.workflow.startsWith('txt') && !isEditVideo,
      };
    },
    ['workflow', 'ecosystem']
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
        // Normalizing on "not already T2V" also catches the root `WanVideo` key, which
        // maps here via extraEcosystems and would otherwise reach prompt analysis
        // unversioned — landing on the built-in image fallback for a video request.
        if (!isImg2vid) {
          const v21 = wanVersionDefs[0];
          if (ctx.ecosystem !== v21.ecosystems.t2v) {
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

  // Alibaba's wan3.0-video API reference documents no cfgScale, so the slider is
  // hidden there rather than offered as a control that does nothing.
  .node(
    'cfgScale',
    (ctx) => ({
      ...sliderNode({
        min: 1,
        max: 10,
        step: 0.5,
        defaultValue: 3.5,
        presets: [
          { label: 'Low', value: 2 },
          { label: 'Balanced', value: 3.5 },
          { label: 'High', value: 6 },
        ],
      }),
      when: ctx.wanVersion !== 'v3.0',
    }),
    ['wanVersion']
  )

  // Version-specific controls via discriminator
  .discriminator('wanVersion', {
    'v2.1': wan21Graph,
    'v2.2': wan22Graph,
    'v2.2-5b': wan225bGraph,
    'v2.5': wan25Graph,
    'v2.7': wan27Graph,
    'v3.0': wan30Graph,
  });

// Export constants for use in components
export {
  wanVersionDefs,
  wanVersionOptions,
  ecosystemToVersionDef,
  wanAspectRatios,
  wan21AspectRatiosByResolution,
  wan22AspectRatios,
  wan25AspectRatiosByResolution,
  wan21Resolutions,
  wan22Resolutions,
  wan225bResolutions,
  wan25Resolutions,
  wanDurations,
  wan25Durations,
  wanInterpolatorModels,
};
