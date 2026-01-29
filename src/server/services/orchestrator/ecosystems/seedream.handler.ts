/**
 * Seedream Ecosystem Handler
 *
 * Handles Seedream workflows using imageGen step type.
 * Supports v3, v4, and v4.5 model versions.
 */

import type { SeedreamImageGenInput, SeedreamVersion } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { seedreamVersionIds } from '~/shared/data-graph/generation/seedream-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type SeedreamCtx = EcosystemGraphOutput & { baseModel: 'Seedream' };

// Create reverse map from version ID to version string
const versionIdToVersion = new Map<number, SeedreamVersion>(
  Object.entries(seedreamVersionIds).map(([version, id]) => [id, version as SeedreamVersion])
);

/**
 * Creates imageGen input for Seedream ecosystem.
 * Handles both txt2img and img2img operations.
 */
export const createSeedreamInput = defineHandler<SeedreamCtx, SeedreamImageGenInput>((data, ctx) => {
  const quantity = data.quantity ?? 1;

  // Determine version from model
  let version: SeedreamVersion = 'v4.5';
  if (data.model) {
    const match = versionIdToVersion.get(data.model.id);
    if (match) version = match;
  }

  return removeEmpty({
    engine: 'seedream',
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    version,
    images: data.images?.map((x) => x.url),
    guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
    enableSafetyChecker: false,
    seed: data.seed,
    quantity,
  }) as SeedreamImageGenInput;
});
