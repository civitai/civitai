/** Flux 3 Video handler for the form-graph lane — t2v / i2v / first-last frame. */

import type {
  Flux3V3FirstLastFrameToVideoInput,
  Flux3V3ImageToVideoInput,
  Flux3V3TextToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

type Flux3VideoInput =
  | Flux3V3TextToVideoInput
  | Flux3V3ImageToVideoInput
  | Flux3V3FirstLastFrameToVideoInput;

export const createFlux3VideoInput = defineHandler<
  EcosystemData<'Flux3Video'>,
  [VideoGenStepTemplate]
>((data) => {
  const startImage = data.images?.[0]?.url;
  const endImage = data.images?.[1]?.url;
  const draft = data.draft;

  const shared = {
    engine: 'flux',
    version: 'v3.0',
    prompt: data.prompt,
    duration: data.duration,
    resolution: draft ? '720p' : data.resolution,
    aspectRatio: startImage
      ? 'auto'
      : (data.aspectRatio?.value as Flux3V3TextToVideoInput['aspectRatio']),
    generateAudio: data.generateAudio,
    draft,
  };

  let input: Flux3VideoInput;
  if (startImage && endImage) {
    input = {
      ...shared,
      operation: 'firstLastFrameToVideo',
      startImage,
      endImage,
    } as Flux3V3FirstLastFrameToVideoInput;
  } else if (startImage) {
    input = {
      ...shared,
      operation: 'imageToVideo',
      image: startImage,
    } as Flux3V3ImageToVideoInput;
  } else if (endImage) {
    throw new Error('A first frame is required when supplying a last frame');
  } else {
    input = { ...shared, operation: 'textToVideo' } as Flux3V3TextToVideoInput;
  }
  return [{ $type: 'videoGen', input: removeEmpty(input) as Flux3VideoInput }];
});
