/**
 * Krea 2 handler for the form-graph lane — one imageGen step, engine picked by
 * version: FAL size tiers (medium/large) vs comfy builds (raw/turbo/edit).
 */

import type {
  ComfyKrea2EditImageInput,
  ComfyKrea2RawCreateImageGenInput,
  ComfyKrea2TurboCreateImageGenInput,
  ImageGenStepTemplate,
  Krea2FalImageGenInput,
  Krea2StyleReference,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import {
  krea2VersionIds,
  krea2VersionIdToSize,
} from '~/shared/form-graph/generation/image/krea2.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type Krea2AspectRatio = NonNullable<Krea2FalImageGenInput['aspectRatio']>;
type Krea2ComfyInput =
  | ComfyKrea2RawCreateImageGenInput
  | ComfyKrea2TurboCreateImageGenInput
  | ComfyKrea2EditImageInput;

export const createKrea2Input = defineHandler<EcosystemData<'Krea2'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    const quantity = data.quantity ?? 1;
    // Edit is comfy-only, so it wins over the FAL size tiers.
    const isEdit = data.workflow === 'img2img:edit';
    const size = !isEdit && data.model ? krea2VersionIdToSize.get(data.model.id) : undefined;

    if (size) {
      const styleRefs = 'styleReferences' in data ? data.styleReferences : undefined;
      const imageStyleReferences: Krea2StyleReference[] = (styleRefs ?? []).map((ref) => ({
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
            creativity: 'creativity' in data ? data.creativity : undefined,
            seed: data.seed,
            quantity,
            imageStyleReferences,
          }) as Krea2FalImageGenInput,
        },
      ];
    }

    const model = isEdit ? 'edit' : data.model?.id === krea2VersionIds.turbo ? 'turbo' : 'raw';

    const loras = resourcesToLoras('resources' in data ? data.resources : undefined, ctx.airs);

    const images = 'images' in data ? data.images?.map((x) => x.url) : undefined;
    if (isEdit && !images?.length) throw new Error('At least one image is required to edit');

    // `model: 'edit'` selects the edit graph, not a checkpoint — the base build
    // rides along as a diffusionModel AIR.
    let diffusionModel: string | undefined;
    if (isEdit) {
      if (!data.model) throw new Error('A Krea 2 base model is required to edit');
      diffusionModel = ctx.airs.getOrThrow(data.model.id);
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'comfy',
          ecosystem: 'krea2',
          model,
          operation: isEdit ? 'editImage' : 'createImage',
          diffusionModel,
          images,
          prompt: data.prompt,
          negativePrompt: data.negativePrompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
          steps: 'steps' in data ? data.steps : undefined,
          sampler: 'euler',
          scheduler: 'simple',
          seed: data.seed,
          quantity,
          loras,
        }) as Krea2ComfyInput,
      },
    ];
  }
);
