/**
 * ACE Audio Ecosystem Handler
 *
 * Handles ACE Audio 1.5 audio generation workflows using aceStepAudio step type.
 * Generates music from text descriptions and structured lyrics.
 *
 * Cover Image Modes:
 * - generateCover=true: Multi-step — prepends an imageGen step (Flux2 Klein 4B)
 *   and references its output via $ref for the cover image
 * - images provided: Single-step — uses the user-supplied image URL as cover
 * - Neither: Single-step — no cover image, output is audio-only
 */

import type {
  AceStepAudioStepTemplate,
  AceStepAudioInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type AceAudioCtx = EcosystemGraphOutput & { ecosystem: 'AceAudio' };

/**
 * Creates step input(s) for ACE Audio ecosystem.
 *
 * Returns either:
 * - [imageGen, aceStepAudio] when generateCover is true (multi-step with $ref)
 * - [aceStepAudio] when a cover image is provided or no cover at all
 */
export const createAceAudioInput = defineHandler<AceAudioCtx, StepInput[]>((data) => {
  const generateCover = 'generateCover' in data ? (data.generateCover as boolean) : false;
  const images = 'images' in data ? (data.images as { url: string }[] | undefined) : undefined;
  const hasCoverImage = !!images?.length;

  // Build the base aceStepAudio input
  const musicDescription = 'musicDescription' in data ? (data.musicDescription as string) : '';
  const aceInput: Record<string, unknown> = {
    musicDescription,
    lyrics: 'lyrics' in data ? (data.lyrics as string) : '',
    seed: data.seed,
    duration: 'duration' in data ? (data.duration as number) : undefined,
    bpm: 'bpm' in data ? (data.bpm as number) : undefined,
    instrumentalWeight:
      'instrumentalWeight' in data ? (data.instrumentalWeight as number) : undefined,
    vocalWeight: 'vocalWeight' in data ? (data.vocalWeight as number) : undefined,
  };

  // Mode 1: generateCover — multi-step with imageGen + aceStepAudio ($ref)
  if (generateCover) {
    const coverPrompt = `Generate an album cover for a song with the following description (dont include text): ${musicDescription}`;

    const imageGenStep: ImageGenStepTemplate & { metadata: { suppressOutput: true } } = {
      $type: 'imageGen',
      input: {
        engine: 'flux2',
        model: 'klein',
        operation: 'createImage',
        modelVersion: '4b',
        steps: 8,
        prompt: coverPrompt,
      } as ImageGenStepTemplate['input'],
      metadata: { suppressOutput: true },
    };

    const aceAudio: AceStepAudioStepTemplate = {
      $type: 'aceStepAudio',
      input: {
        ...removeEmpty(aceInput),
        cover: {
          imageUrl: { $ref: '$0', path: 'output.images[0].url' } as unknown as string,
        },
      } as AceStepAudioInput,
    };

    return [imageGenStep, aceAudio];
  }

  // Mode 2: user-supplied cover image — single step with cover URL
  if (hasCoverImage) {
    aceInput.cover = { imageUrl: images[0].url };
  }

  // Mode 2 & 3: single aceStepAudio step (with or without cover)
  const aceAudio: AceStepAudioStepTemplate = {
    $type: 'aceStepAudio',
    input: removeEmpty(aceInput) as AceStepAudioInput,
  };

  return [aceAudio];
});
