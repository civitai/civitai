/** Flux 3 Video handler for the form-graph lane (v3.0 and v3.0 Max). */

import type {
  Flux3MaxImageToVideoInput,
  Flux3MaxKeyframesToVideoInput,
  Flux3MaxTextToVideoInput,
  Flux3V3FirstLastFrameToVideoInput,
  Flux3V3ImageToVideoInput,
  Flux3V3TextToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/orchestration-client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { FLUX3_KEYFRAMES_WORKFLOW } from '~/shared/form-graph/generation/video/flux3-video.graph';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type Flux3VideoData = EcosystemData<'Flux3Video'>;
type Flux3V3Data = Extract<Flux3VideoData, { flux3VideoVersion: 'v3' }>;
type Flux3MaxData = Extract<Flux3VideoData, { flux3VideoVersion: 'max' }>;

type Flux3V3Input =
  | Flux3V3TextToVideoInput
  | Flux3V3ImageToVideoInput
  | Flux3V3FirstLastFrameToVideoInput;

type Flux3MaxInput =
  | Flux3MaxTextToVideoInput
  | Flux3MaxImageToVideoInput
  | Flux3MaxKeyframesToVideoInput;

export const createFlux3VideoInput = defineHandler<Flux3VideoData, [VideoGenStepTemplate]>(
  (data) => {
    // A locked picker swaps a version the user may not see for the default, which would turn a
    // keyframes request into a v3.0 text-to-video and bill for it.
    if (data.workflow === FLUX3_KEYFRAMES_WORKFLOW && data.flux3VideoVersion !== 'max')
      throw throwBadRequestError('Keyframes need Flux 3 Video v3.0 Max');
    const input = data.flux3VideoVersion === 'max' ? createMaxInput(data) : createV3Input(data);
    return [{ $type: 'videoGen', input }];
  }
);

function createV3Input(data: Flux3V3Data): Flux3V3Input {
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

  let input: Flux3V3Input;
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
  return removeEmpty(input) as Flux3V3Input;
}

function createMaxInput(data: Flux3MaxData): Flux3MaxInput {
  const startImage = data.images?.[0]?.url;
  const endImage = data.images?.[1]?.url;
  const keyframes = data.keyframes;
  const imageDriven = !!startImage || !!keyframes?.length;

  const shared = {
    engine: 'flux',
    version: 'v3.0-max',
    prompt: data.prompt,
    duration: data.duration,
    resolution: data.resolution,
    aspectRatio: imageDriven
      ? 'auto'
      : (data.aspectRatio?.value as Flux3MaxTextToVideoInput['aspectRatio']),
    generateAudio: data.generateAudio,
    reasoningLevel: data.reasoningLevel,
    seed: data.seed,
  };

  let input: Flux3MaxInput;
  if (keyframes?.length) {
    input = {
      ...shared,
      operation: 'keyframesToVideo',
      keyframes: [...keyframes]
        .sort((a, b) => a.frameIndex - b.frameIndex)
        .map((k) => ({ image: k.image.url, frameIndex: k.frameIndex })),
    } as Flux3MaxKeyframesToVideoInput;
  } else if (startImage) {
    input = {
      ...shared,
      operation: 'imageToVideo',
      image: startImage,
      endImage,
    } as Flux3MaxImageToVideoInput;
  } else if (endImage) {
    throw new Error('A first frame is required when supplying a last frame');
  } else {
    input = { ...shared, operation: 'textToVideo' } as Flux3MaxTextToVideoInput;
  }
  return removeEmpty(input) as Flux3MaxInput;
}
