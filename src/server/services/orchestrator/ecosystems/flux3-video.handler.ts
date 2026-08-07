/**
 * Flux 3 Video Ecosystem Handler
 *
 * Handles Black Forest Labs FLUX-3 Video generation (engine `flux`, version
 * `v3.0`) using the videoGen step type. Covers the textToVideo, imageToVideo
 * and firstLastFrameToVideo operations.
 */

import type {
  Flux3V3FirstLastFrameToVideoInput,
  Flux3V3ImageToVideoInput,
  Flux3V3TextToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Flux3VideoCtx = EcosystemGraphOutput & { ecosystem: 'Flux3Video' };

type Flux3VideoInput =
  | Flux3V3TextToVideoInput
  | Flux3V3ImageToVideoInput
  | Flux3V3FirstLastFrameToVideoInput;

type SharedOptions = Pick<
  Flux3V3TextToVideoInput,
  | 'engine'
  | 'version'
  | 'prompt'
  | 'duration'
  | 'resolution'
  | 'aspectRatio'
  | 'generateAudio'
  | 'draft'
>;

export const createFlux3VideoInput = defineHandler<Flux3VideoCtx, [VideoGenStepTemplate]>(
  (data) => {
    // The operation is chosen by how many frames the user supplied, not by the
    // workflow key: img2vid carries an optional second slot that promotes the
    // step to firstLastFrameToVideo.
    const startImage = data.images?.[0]?.url;
    const endImage = data.images?.[1]?.url;

    const shared: SharedOptions = {
      engine: 'flux',
      version: 'v3.0',
      prompt: data.prompt,
      duration: data.duration,
      // Draft always renders 720p; the resolution control is hidden in that case.
      resolution: data.draft ? '720p' : (data.resolution as Flux3V3TextToVideoInput['resolution']),
      // A supplied frame dictates the framing, so let the model adapt to it.
      aspectRatio: startImage
        ? 'auto'
        : (data.aspectRatio?.value as Flux3V3TextToVideoInput['aspectRatio']),
      generateAudio: data.generateAudio,
      draft: data.draft,
    };

    let input: Flux3VideoInput;
    if (startImage && endImage) {
      input = { ...shared, operation: 'firstLastFrameToVideo', startImage, endImage };
    } else if (startImage) {
      input = { ...shared, operation: 'imageToVideo', image: startImage };
    } else if (endImage) {
      throw new Error('A first frame is required when supplying a last frame');
    } else {
      input = { ...shared, operation: 'textToVideo' };
    }

    return [{ $type: 'videoGen', input: removeEmpty(input) as Flux3VideoInput }];
  }
);
