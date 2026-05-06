/**
 * ACE Audio Ecosystem Handler
 *
 * Handles ACE Audio 1.5 audio generation workflows using aceStepAudio step type.
 * Builds a sequence of up to three steps, in order:
 *
 *   1. imageGen — when generateCover is true (Flux2 Klein 4B). Result is
 *      referenced by the aceStepAudio step's `cover.imageUrl`.
 *   2. chatCompletion — simple mode only. Converts the user prompt + duration
 *      into { lyrics, musicDescription, bpm, key } via a JSON-schema response
 *      format. Referenced by the aceStepAudio step's musicDescription/lyrics/
 *      bpm/key fields.
 *   3. aceStepAudio — always. Pulls inputs either directly from form data
 *      (custom mode) or via $ref from the chat step (simple mode). Cover
 *      image comes from either the imageGen step (via $ref), the user's
 *      uploaded image, or is omitted entirely.
 */

import type {
  AceStepAudioInput,
  AceStepAudioStepTemplate,
  ChatCompletionInput,
  ChatCompletionStepTemplate,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import {
  ACE_AUDIO_MAX_BPM,
  ACE_AUDIO_MIN_BPM,
} from '~/shared/data-graph/generation/ace-audio-graph';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type AceAudioCtx = EcosystemGraphOutput & { ecosystem: 'Ace' };

const SIMPLE_CHAT_MODEL = 'gpt-4o-mini';
const SIMPLE_CHAT_TEMPERATURE = 0.9;
const SIMPLE_SYSTEM_PROMPT =
  'You write short song concepts. Always respond with the requested JSON shape.';

const SIMPLE_RESPONSE_FORMAT = {
  type: 'json_schema',
  jsonSchema: {
    name: 'song_concept',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        lyrics: { type: 'string' },
        musicDescription: { type: 'string' },
        bpm: { type: 'integer', minimum: ACE_AUDIO_MIN_BPM, maximum: ACE_AUDIO_MAX_BPM },
        key: { type: 'string' },
      },
      required: ['lyrics', 'musicDescription', 'bpm', 'key'],
      additionalProperties: false,
    },
  },
};

export const createAceAudioInput = defineHandler<AceAudioCtx, StepInput[]>((data, ctx) => {
  const diffusionModel = data.model ? ctx.airs.getOrThrow(data.model.id) : undefined;
  // Cover description is the user's prompt in simple mode (chat-derived
  // musicDescription isn't resolved at submission time) or the user's
  // musicDescription in custom mode. Ternary narrows on the discriminator.
  const coverDescription = data.aceAudioMode === 'simple' ? data.prompt : data.musicDescription;

  const steps: StepInput[] = [];

  // -------------------------------------------------------------------------
  // Step 1 (optional): imageGen — cover image
  // -------------------------------------------------------------------------
  let coverRef: string | undefined;
  if (data.generateCover) {
    coverRef = `$${steps.length}`;
    const coverStep: ImageGenStepTemplate & { metadata: { suppressOutput: true } } = {
      $type: 'imageGen',
      input: {
        engine: 'flux2',
        model: 'klein',
        operation: 'createImage',
        modelVersion: '4b',
        steps: 8,
        prompt: `Generate an album cover for a song with the following description (dont include text): ${coverDescription}`,
      } as ImageGenStepTemplate['input'],
      metadata: { suppressOutput: true },
    };
    steps.push(coverStep);
  }

  // -------------------------------------------------------------------------
  // Step 2 (simple mode only): chatCompletion → lyrics/musicDescription/bpm/key
  // -------------------------------------------------------------------------
  let chatRef: string | undefined;
  if (data.aceAudioMode === 'simple') {
    chatRef = `$${steps.length}`;
    const chatStep: ChatCompletionStepTemplate & { metadata: { suppressOutput: true } } = {
      $type: 'chatCompletion',
      input: {
        model: SIMPLE_CHAT_MODEL,
        messages: [
          { role: 'system', content: SIMPLE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Write a ${data.duration}-second song. ${data.prompt}. Output JSON with lyrics, musicDescription, bpm (${ACE_AUDIO_MIN_BPM}-${ACE_AUDIO_MAX_BPM}), key.`,
          },
        ],
        temperature: SIMPLE_CHAT_TEMPERATURE,
        responseFormat: SIMPLE_RESPONSE_FORMAT,
      } as unknown as ChatCompletionInput,
      metadata: { suppressOutput: true },
    };
    steps.push(chatStep);
  }

  // -------------------------------------------------------------------------
  // Step 3: aceStepAudio — the actual generation. Mode-specific fields are
  // spread from the discriminator-narrowed branches below; shared fields
  // (duration/seed/diffusionModel/cover) sit at the top level.
  // -------------------------------------------------------------------------
  const cover = coverRef
    ? { imageUrl: { $ref: coverRef, path: 'output.images[0].url' } as unknown as string }
    : data.images?.length
    ? { imageUrl: data.images[0].url }
    : undefined;

  const aceInput = removeEmpty({
    duration: data.duration,
    seed: data.seed,
    diffusionModel,
    cover,
    ...(data.aceAudioMode === 'simple'
      ? {
          // chatRef is set above whenever aceAudioMode === 'simple'.
          musicDescription: { $ref: chatRef!, path: 'output.parsed.musicDescription' },
          lyrics: { $ref: chatRef!, path: 'output.parsed.lyrics' },
          bpm: { $ref: chatRef!, path: 'output.parsed.bpm' },
          key: { $ref: chatRef!, path: 'output.parsed.key' },
        }
      : {
          musicDescription: data.musicDescription,
          lyrics: data.lyrics,
          bpm: data.bpm,
          instrumentalWeight: data.instrumentalWeight,
          vocalWeight: data.vocalWeight,
          steps: data.steps,
          cfg: data.cfgScale,
        }),
  });

  const aceAudio: AceStepAudioStepTemplate = {
    $type: 'aceStepAudio',
    input: aceInput as AceStepAudioInput,
  };

  steps.push(aceAudio);
  return steps;
});
