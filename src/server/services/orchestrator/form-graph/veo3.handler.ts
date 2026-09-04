/** Veo 3 handler for the form-graph lane — fast/standard modes on one engine. */

import type { Veo3VideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { veo3AspectRatios, veo3VersionIds } from '~/shared/form-graph/generation/video/veo3.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

type Veo3Mode = 'fast' | 'standard';
const versionIdToMode = new Map<number, Veo3Mode>([
  [veo3VersionIds.fast, 'fast'],
  [veo3VersionIds.standard, 'standard'],
]);

function getImageAspectRatio(images: { width: number; height: number }[] | undefined) {
  const img = images?.[0];
  if (!img?.width || !img?.height) return undefined;
  return findClosestAspectRatio({ width: img.width, height: img.height }, [...veo3AspectRatios])
    .value;
}

export const createVeo3Input = defineHandler<EcosystemData<'Veo3'>, [VideoGenStepTemplate]>(
  (data, ctx) => {
    const images = data.images;
    const isRef2Vid = data.workflow === 'img2vid:ref2vid';
    const hasImages = !!images?.length;

    const mode: Veo3Mode = (data.model ? versionIdToMode.get(data.model.id) : undefined) ?? 'fast';

    // The Veo3 graph declares no resources field, so this is always empty today.
    const resources = (data as { resources?: { id: number; strength?: number }[] }).resources;
    const loras = (resources ?? []).map((resource) => ({
      air: ctx.airs.getOrThrow(resource.id),
      strength: resource.strength ?? 1,
    }));

    // ref2vid with an empty prompt: reference each image so the engine has text
    const prompt =
      isRef2Vid && !data.prompt?.length && hasImages
        ? images!.map((_, index) => `[@image${index + 1}]`).join()
        : data.prompt;

    const refImages = isRef2Vid && hasImages ? images!.map((x) => x.url) : undefined;
    const sourceImages = !isRef2Vid && hasImages ? images!.map((x) => x.url) : undefined;

    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'veo3',
          fastMode: mode === 'fast',
          prompt,
          negativePrompt: data.negativePrompt,
          aspectRatio: (data.aspectRatio?.value ??
            getImageAspectRatio(images)) as Veo3VideoGenInput['aspectRatio'],
          duration: data.duration,
          // Never let this fall through as undefined: the orchestrator's
          // Veo3Version zero value is 3.0, whose endpoints Google retired.
          version: data.version ?? '3.1',
          generateAudio: data.generateAudio,
          images: refImages ?? sourceImages,
          quantity: data.quantity ?? 1,
          seed: data.seed,
          // Veo 3.1 requires it, so it isn't offered as a control.
          enablePromptEnhancer: true,
          loras: loras.length > 0 ? loras : undefined,
        }) as Veo3VideoGenInput,
      },
    ];
  }
);
