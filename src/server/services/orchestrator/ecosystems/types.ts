/**
 * Ecosystem Handler Types
 *
 * Shared type definitions for ecosystem step input creators.
 * Types are derived from the generation graph where possible.
 */

import type { WorkflowStepTemplate } from '@civitai/client';
import type { ResourceData } from '~/shared/data-graph/generation/common';

// Re-export ResourceData from the generation graph
export type { ResourceData };

/**
 * Aspect ratio data from generation graph.
 */
export type AspectRatioData = {
  width: number;
  height: number;
  value: string;
};

/**
 * Source image data for img2img workflows.
 */
export type SourceImageData = {
  url: string;
  width: number;
  height: number;
};

/**
 * Step input result from ecosystem handlers.
 * Contains the $type and input for the orchestrator step.
 */
export type StepInput = WorkflowStepTemplate & {
  input: unknown;
};

/**
 * Common fields available on ecosystem graph outputs.
 * Each ecosystem may have additional specific fields.
 */
export interface BaseEcosystemData {
  workflow: string;
  output: 'image' | 'video';
  baseModel: string;
  model?: ResourceData;
  prompt: string;
  quantity?: number;
  priority?: number;
  outputFormat?: string;
}

/**
 * Image ecosystem base data (extends base with image-specific fields).
 */
export interface ImageEcosystemData extends BaseEcosystemData {
  output: 'image';
  negativePrompt?: string;
  aspectRatio?: AspectRatioData;
  images?: SourceImageData[];
  seed?: number;
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  clipSkip?: number;
  denoise?: number;
}

/**
 * Video ecosystem base data (extends base with video-specific fields).
 */
export interface VideoEcosystemData extends BaseEcosystemData {
  output: 'video';
  video?: { url: string };
  duration?: number;
  fps?: number;
}
