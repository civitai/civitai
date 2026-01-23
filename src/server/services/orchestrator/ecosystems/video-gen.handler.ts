/**
 * Video Generation Ecosystem Handler
 *
 * Handles video ecosystems that use the videoGen step type:
 * - Wan family (WanVideo variants)
 * - Vidu, Kling, HyV1, MiniMax, Haiper, Mochi, Lightricks, Sora2, Veo3
 *
 * Uses existing video generation configs from server/orchestrator
 */

import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import type { StepInput, ResourceData, AspectRatioData, SourceImageData } from './types';

// =============================================================================
// Types
// =============================================================================

/** Video ecosystems mapped to their engine keys */
type VideoEcosystem =
  | 'WanVideo'
  | 'WanVideo1_3B_T2V'
  | 'WanVideo14B_T2V'
  | 'WanVideo14B_I2V_480p'
  | 'WanVideo14B_I2V_720p'
  | 'WanVideo22_TI2V_5B'
  | 'WanVideo22_I2V_A14B'
  | 'WanVideo22_T2V_A14B'
  | 'WanVideo25_T2V'
  | 'WanVideo25_I2V'
  | 'Vidu'
  | 'Kling'
  | 'HyV1'
  | 'MiniMax'
  | 'Haiper'
  | 'Mochi'
  | 'Lightricks'
  | 'Sora2'
  | 'Veo3';

/** Map from baseModel to video generation engine key */
const ECOSYSTEM_TO_ENGINE: Partial<Record<VideoEcosystem, keyof typeof videoGenerationConfig2>> = {
  // Wan family - all map to 'wan' engine
  WanVideo: 'wan',
  WanVideo1_3B_T2V: 'wan',
  WanVideo14B_T2V: 'wan',
  WanVideo14B_I2V_480p: 'wan',
  WanVideo14B_I2V_720p: 'wan',
  WanVideo22_TI2V_5B: 'wan',
  WanVideo22_I2V_A14B: 'wan',
  WanVideo22_T2V_A14B: 'wan',
  WanVideo25_T2V: 'wan',
  WanVideo25_I2V: 'wan',
  // Individual video ecosystems
  Vidu: 'vidu',
  Kling: 'kling',
  HyV1: 'hunyuan',
  MiniMax: 'minimax',
  Haiper: 'haiper',
  Mochi: 'mochi',
  Lightricks: 'lightricks',
  Sora2: 'sora',
  Veo3: 'veo3',
};

/** Video ecosystem data from generation graph */
export type VideoEcosystemData = {
  baseModel: VideoEcosystem;
  workflow: string;
  model?: ResourceData;
  resources?: ResourceData[];
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: AspectRatioData;
  images?: SourceImageData[];
  video?: { url: string };
  seed?: number;
  cfgScale?: number;
  steps?: number;
  // Wan-specific
  version?: string;
  resolution?: string | number; // Can be string like "720p" or number depending on ecosystem
  duration?: number | string; // Can be number or string like "5" | "10" depending on ecosystem
  shift?: number;
  interpolatorModel?: string;
  useTurbo?: boolean;
  draft?: boolean;
  enablePromptExpansion?: boolean;
  // Video-specific
  fps?: number;
  motion?: number;
  priority?: 'low' | 'normal' | 'high';
};

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Creates step input for video generation ecosystems.
 *
 * Uses the ecosystem's config to build the appropriate step input.
 */
export async function createVideoGenInput(data: VideoEcosystemData): Promise<StepInput> {
  const engine = ECOSYSTEM_TO_ENGINE[data.baseModel];
  if (!engine) {
    throw new Error(`No video generation engine found for ecosystem: ${data.baseModel}`);
  }

  const config = videoGenerationConfig2[engine];
  if (!config) {
    throw new Error(`Missing video generation config for engine: ${engine}`);
  }

  // Determine process type from workflow
  const process = data.workflow.startsWith('img2vid') ? 'img2vid' : 'txt2vid';

  // Build resources array
  const resources = [
    ...(data.model
      ? [{ id: data.model.id, air: resourceToAir(data.model), strength: data.model.strength ?? 1 }]
      : []),
    ...(data.resources?.map((r) => ({ id: r.id, air: resourceToAir(r), strength: r.strength ?? 1 })) ?? []),
  ];

  // Build params for the config
  const params: Record<string, unknown> = {
    engine,
    baseModel: data.baseModel,
    process,
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    seed: data.seed,
    cfgScale: data.cfgScale,
    steps: data.steps,
    // Dimensions from aspect ratio
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    aspectRatio: data.aspectRatio?.value,
    // Source image/video
    sourceImage: data.images?.[0],
    images: data.images,
    video: data.video,
    // Wan-specific
    version: data.version,
    resolution: data.resolution,
    duration: data.duration,
    shift: data.shift,
    interpolatorModel: data.interpolatorModel,
    useTurbo: data.useTurbo,
    draft: data.draft,
    enablePromptExpansion: data.enablePromptExpansion,
    // Video-specific
    fps: data.fps,
    motion: data.motion,
    // Resources
    resources: resources.length > 0 ? resources : null,
  };

  return {
    $type: 'videoGen',
    input: config.inputFn(params as any),
  } as StepInput;
}

/**
 * Checks if a baseModel uses the videoGen step type.
 */
export function isVideoEcosystem(baseModel: string): baseModel is VideoEcosystem {
  return baseModel in ECOSYSTEM_TO_ENGINE;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Converts a ResourceData object to an AIR string for video resources.
 */
function resourceToAir(resource: ResourceData): string {
  const ecosystem = getEcosystemFromBaseModel(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
}

/**
 * Maps baseModel strings to ecosystem names for AIR generation.
 */
function getEcosystemFromBaseModel(baseModel: string): string {
  // Video base models typically map directly
  if (baseModel.startsWith('Wan')) return 'wan';
  return baseModel.toLowerCase();
}
