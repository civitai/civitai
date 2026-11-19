/** Gemini Omni handler for the form-graph lane (1.1 Flash and 1.2 Flash). */

import type { GeminiOmniVideoGenInput, VideoGenStepTemplate } from '@civitai/orchestration-client';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import {
  geminiOmniAspectRatios,
  geminiOmniModelOf,
} from '~/shared/form-graph/generation/video/gemini-omni.graph';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

export const createGeminiOmniInput = defineHandler<
  EcosystemData<'GeminiOmni'>,
  [VideoGenStepTemplate]
>((data) => {
  const images = data.images ?? [];
  const firstFrame = data.workflow !== 'img2vid:ref2vid' ? images[0] : undefined;
  const aspectRatio = firstFrame?.width
    ? findClosestAspectRatio(firstFrame, [...geminiOmniAspectRatios]).value
    : data.aspectRatio?.value;
  const model = geminiOmniModelOf(data.model);

  return [
    {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'gemini-omni',
        model,
        prompt: data.prompt,
        aspectRatio: aspectRatio as GeminiOmniVideoGenInput['aspectRatio'],
        resolution: data.resolution,
        images: images.map((x) => x.url),
        // The engine refuses a duration on 1.1.
        duration: model === '1.2-flash' ? data.duration : undefined,
      }) as GeminiOmniVideoGenInput,
    },
  ];
});
