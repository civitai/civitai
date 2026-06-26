/**
 * Krea 2 Ecosystem Handler
 *
 * The Krea 2 checkpoint is locked, but its version selector splits across two
 * engines (see krea2-graph.ts):
 *
 * - medium/large → FAL engine (Krea2FalImageGenInput). Size tiers, no LoRA;
 *   exposes creativity + style references.
 * - raw/turbo    → comfy engine (ComfyKrea2Raw/TurboCreateImageGenInput).
 *   LoRA support; exposes negativePrompt + cfgScale + steps.
 *
 * Both paths emit a single imageGen step. The selected model version decides
 * which branch runs: a medium/large size mapping ⇒ FAL, otherwise comfy.
 */

import type {
  ComfyKrea2RawCreateImageGenInput,
  ComfyKrea2TurboCreateImageGenInput,
  ImageGenStepTemplate,
  Krea2FalImageGenInput,
  Krea2StyleReference,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import {
  krea2VersionIds,
  krea2VersionIdToSize,
} from '~/shared/data-graph/generation/krea2-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Krea2Ctx = EcosystemGraphOutput & { ecosystem: 'Krea2' };

type Krea2AspectRatio = NonNullable<Krea2FalImageGenInput['aspectRatio']>;
type Krea2Creativity = NonNullable<Krea2FalImageGenInput['creativity']>;
type Krea2ComfyInput = ComfyKrea2RawCreateImageGenInput | ComfyKrea2TurboCreateImageGenInput;

export const createKrea2Input = defineHandler<Krea2Ctx, [ImageGenStepTemplate]>((data, ctx) => {
  const quantity = data.quantity ?? 1;
  const size = data.model ? krea2VersionIdToSize.get(data.model.id) : undefined;

  // FAL path — official medium/large size tiers (no LoRA).
  if (size) {
    const styleRefs =
      'styleReferences' in data && Array.isArray(data.styleReferences) ? data.styleReferences : [];
    const imageStyleReferences: Krea2StyleReference[] = styleRefs.map((ref) => ({
      imageUrl: ref.image.url,
      strength: ref.strength,
    }));

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'fal',
          model: 'krea2',
          operation: 'createImage',
          prompt: data.prompt,
          aspectRatio: data.aspectRatio?.value as Krea2AspectRatio | undefined,
          size,
          creativity: 'creativity' in data ? (data.creativity as Krea2Creativity) : undefined,
          seed: data.seed,
          quantity,
          imageStyleReferences,
        }) as Krea2FalImageGenInput,
      },
    ];
  }

  // Comfy path — raw/turbo variants (LoRA support). Sampler/scheduler are fixed
  // (not exposed in the UI), matching the Lens comfy handler.
  const model = data.model?.id === krea2VersionIds.turbo ? 'turbo' : 'raw';

  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'comfy',
        ecosystem: 'krea2',
        model,
        operation: 'createImage',
        prompt: data.prompt,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        width: data.aspectRatio?.width,
        height: data.aspectRatio?.height,
        cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
        steps: 'steps' in data ? data.steps : undefined,
        sampler: 'euler',
        scheduler: 'simple',
        seed: data.seed,
        quantity,
        loras: Object.keys(loras).length > 0 ? loras : undefined,
      }) as Krea2ComfyInput,
    },
  ];
});
