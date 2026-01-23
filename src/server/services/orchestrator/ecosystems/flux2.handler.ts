/**
 * Flux2 Ecosystem Handler
 *
 * Handles Flux2 workflows using imageGen step type.
 * Supports dev, flex, pro, and max modes.
 */

import type {
  Flux2DevImageGenInput,
  Flux2FlexImageGenInput,
  Flux2MaxImageGenInput,
  Flux2ProImageGenInput,
} from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { flux2VersionIds, type Flux2Mode } from '~/shared/data-graph/generation/flux2-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type Flux2Ctx = EcosystemGraphOutput & { baseModel: 'Flux2' };

// Return type union
type Flux2Input =
  | Flux2DevImageGenInput
  | Flux2FlexImageGenInput
  | Flux2ProImageGenInput
  | Flux2MaxImageGenInput;

// Create reverse map from version ID to mode
const versionIdToMode = new Map<number, Flux2Mode>(
  Object.entries(flux2VersionIds).map(([mode, id]) => [id, mode as Flux2Mode])
);

/**
 * Converts a ResourceData object to a lora resource for Flux2.
 */
function resourceToLora(resource: ResourceData) {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  const air = `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
  return { air, strength: resource.strength ?? 1 };
}

/**
 * Creates imageGen input for Flux2 ecosystem.
 * Handles both txt2img and img2img operations.
 * LoRAs are only supported in dev mode.
 */
export async function createFlux2Input(data: Flux2Ctx): Promise<Flux2Input> {
  const seed = data.seed ?? Math.floor(Math.random() * maxRandomSeed);
  const quantity = data.quantity ?? 1;

  // Determine model from model version
  let model: Flux2Mode = 'dev';
  if (data.model) {
    const match = versionIdToMode.get(data.model.id);
    if (match) model = match;
  }

  // Build loras from additional resources (only for dev mode)
  const loras: { air: string; strength: number }[] = [];
  if (model === 'dev' && 'resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras.push(resourceToLora(resource));
    }
  }

  const hasImages = !!data.images?.length;
  const operation = hasImages ? 'editImage' : 'createImage';

  return removeEmpty({
    engine: 'flux2',
    model,
    operation,
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
    numInferenceSteps: 'steps' in data ? data.steps : undefined,
    quantity,
    seed,
    loras: loras.length > 0 ? loras : undefined,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
  }) as Flux2Input;
}
