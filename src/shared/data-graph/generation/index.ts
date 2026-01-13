/**
 * Generation Graph V2
 *
 * DataGraph v2 implementation where meta only contains dynamic props.
 * Static props (label, buttonLabel, placeholder, etc.) are defined in components.
 */

export {
  generationGraph,
  type GenerationGraphCtx,
  type GenerationGraphTypes,
} from './generation-graph';
export { stableDiffusionGraph } from './stable-diffusion-graph';
export { fluxGraph } from './flux-graph';
export {
  videoInterpolationGraph,
  type VideoInterpolationGraphCtx,
} from './video-interpolation-graph';
export { videoUpscaleGraph, type VideoUpscaleGraphCtx } from './video-upscale-graph';
export {
  // Node builders
  aspectRatioNode,
  promptNode,
  negativePromptNode,
  samplerNode,
  cfgScaleNode,
  stepsNode,
  clipSkipNode,
  seedNode,
  resourcesNode,
  vaeNode,
  videoNode,
  denoiseNode,
  // Subgraph builders
  createCheckpointGraph,
  // Input graphs
  textInputGraph,
  imageInputGraph,
  // Types
  type AspectRatioOption,
  type CheckpointVersionOption,
  type VideoMetadata,
  type VideoValue,
} from './common';
export type { GenerationCtx } from './context';
