/**
 * ACE Audio handler for the form-graph lane — up to three steps: an optional
 * flux2-klein cover imageGen, a simple-mode chatCompletion that drafts
 * lyrics/description/bpm/key, and the aceStepAudio step that $refs them.
 */

import type {
  AceStepAudioInput,
  AceStepAudioStepTemplate,
  ChatCompletionInput,
  ChatCompletionStepTemplate,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import {
  ACE_AUDIO_MAX_BPM,
  ACE_AUDIO_MIN_BPM,
} from '~/shared/form-graph/generation/audio/ace.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { StepInput } from '../ecosystems';
import type { LooseGenerationData } from './types';

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

export const createAceAudioInput = defineHandler<LooseGenerationData, StepInput[]>((data, ctx) => {
  const d = data as LooseGenerationData & {
    aceAudioMode?: 'simple' | 'custom';
    generateCover?: boolean;
    musicDescription?: string;
    lyrics?: string;
    bpm?: number;
    instrumentalWeight?: number;
    vocalWeight?: number;
  };
  const diffusionModel = d.model ? ctx.airs.getOrThrow(d.model.id) : undefined;
  const coverDescription = d.aceAudioMode === 'simple' ? d.prompt : d.musicDescription;

  const steps: StepInput[] = [];

  let coverRef: string | undefined;
  if (d.generateCover) {
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

  let chatRef: string | undefined;
  if (d.aceAudioMode === 'simple') {
    chatRef = `$${steps.length}`;
    const chatStep: ChatCompletionStepTemplate & { metadata: { suppressOutput: true } } = {
      $type: 'chatCompletion',
      input: {
        model: SIMPLE_CHAT_MODEL,
        messages: [
          { role: 'system', content: SIMPLE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Write a ${d.duration}-second song. ${d.prompt}. Output JSON with lyrics, musicDescription, bpm (${ACE_AUDIO_MIN_BPM}-${ACE_AUDIO_MAX_BPM}), key.`,
          },
        ],
        temperature: SIMPLE_CHAT_TEMPERATURE,
        responseFormat: SIMPLE_RESPONSE_FORMAT,
      } as unknown as ChatCompletionInput,
      metadata: { suppressOutput: true },
    };
    steps.push(chatStep);
  }

  const cover = coverRef
    ? { imageUrl: { $ref: coverRef, path: 'output.images[0].url' } as unknown as string }
    : d.images?.length
    ? { imageUrl: d.images[0].url }
    : undefined;

  const aceInput = removeEmpty({
    duration: d.duration,
    seed: d.seed,
    diffusionModel,
    cover,
    ...(d.aceAudioMode === 'simple'
      ? {
          musicDescription: { $ref: chatRef!, path: 'output.parsed.musicDescription' },
          lyrics: { $ref: chatRef!, path: 'output.parsed.lyrics' },
          bpm: { $ref: chatRef!, path: 'output.parsed.bpm' },
          key: { $ref: chatRef!, path: 'output.parsed.key' },
        }
      : {
          musicDescription: d.musicDescription,
          lyrics: d.lyrics,
          bpm: d.bpm,
          instrumentalWeight: d.instrumentalWeight,
          vocalWeight: d.vocalWeight,
          steps: d.steps,
          cfg: d.cfgScale,
        }),
  });

  steps.push({
    $type: 'aceStepAudio',
    input: aceInput as AceStepAudioInput,
  } as AceStepAudioStepTemplate as unknown as StepInput);
  return steps;
});
