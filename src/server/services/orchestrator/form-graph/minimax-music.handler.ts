/**
 * MiniMax Music 3 handler for the form-graph lane — a simple-mode
 * chatCompletion drafting caption + lyrics, then the miniMaxMusic3 step that
 * $refs (or carries) them.
 */

import type {
  ChatCompletionInput,
  ChatCompletionStepTemplate,
  MiniMaxMusic3Input,
  MiniMaxMusic3StepTemplate,
} from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { StepInput } from '../ecosystems';
import type { EcosystemData } from './types';

const SIMPLE_CHAT_MODEL = 'gpt-4o-mini';
const SIMPLE_CHAT_TEMPERATURE = 0.9;

const SIMPLE_SYSTEM_PROMPT =
  'You write song concepts for a music generation model. The caption must be a structured description with three labelled sections — Global Metadata (genre, subgenre, BPM, key, scale, emotional progression, production profile), Vocal Details (vocal gender, timbre, performance style, harmony, effects) and Arrangement (primary and secondary instruments, section-level evolution, groove, bass, percussion, textures). The lyrics must use section markers such as [Intro], [Verse], [Pre-Chorus], [Chorus], [Bridge] and [Outro]. Always respond with the requested JSON shape.';

const SIMPLE_RESPONSE_FORMAT = {
  type: 'json_schema',
  jsonSchema: {
    name: 'song_concept',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        caption: { type: 'string' },
        lyrics: { type: 'string' },
      },
      required: ['caption', 'lyrics'],
      additionalProperties: false,
    },
  },
};

type MiniMaxMusicData = EcosystemData<'MiniMaxMusic3'>;

export const createMiniMaxMusicInput = defineHandler<MiniMaxMusicData, StepInput[]>((data) => {
  // minimaxMusicMode picks the mode arm, so these narrow to the same split
  const simple = 'prompt' in data ? data : undefined;
  const custom = 'musicDescription' in data ? data : undefined;
  const steps: StepInput[] = [];

  let chatRef: string | undefined;
  if (data.minimaxMusicMode === 'simple') {
    chatRef = `$${steps.length}`;
    const chatStep: ChatCompletionStepTemplate & { metadata: { suppressOutput: true } } = {
      $type: 'chatCompletion',
      input: {
        model: SIMPLE_CHAT_MODEL,
        messages: [
          { role: 'system', content: SIMPLE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Write a song of at most ${data.duration} seconds. ${simple?.prompt}. Output JSON with caption and lyrics.`,
          },
        ],
        temperature: SIMPLE_CHAT_TEMPERATURE,
        responseFormat: SIMPLE_RESPONSE_FORMAT,
      } as unknown as ChatCompletionInput,
      metadata: { suppressOutput: true },
    };
    steps.push(chatStep);
  }

  const musicInput = removeEmpty({
    seed: data.seed ?? Math.floor(Math.random() * maxRandomSeed),
    maxDuration: data.duration,
    ...(data.minimaxMusicMode === 'simple'
      ? {
          caption: { $ref: chatRef!, path: 'output.parsed.caption' },
          lyrics: { $ref: chatRef!, path: 'output.parsed.lyrics' },
        }
      : {
          caption: custom?.musicDescription,
          lyrics: custom?.lyrics,
        }),
  });

  steps.push({
    $type: 'miniMaxMusic3',
    input: musicInput as unknown as MiniMaxMusic3Input,
  } as MiniMaxMusic3StepTemplate as unknown as StepInput);
  return steps;
});
