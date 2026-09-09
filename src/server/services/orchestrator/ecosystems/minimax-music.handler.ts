/**
 * MiniMax Music 3 Ecosystem Handler
 *
 * Builds up to two steps:
 *
 *   1. chatCompletion — simple mode only. Turns the user's plain-English prompt
 *      into { caption, lyrics } via a JSON-schema response format. Referenced by
 *      the miniMaxMusic3 step's caption/lyrics fields.
 *   2. miniMaxMusic3 — always. Reads caption/lyrics either from form data
 *      (custom mode) or via $ref from the chat step (simple mode).
 */

import type {
  ChatCompletionInput,
  ChatCompletionStepTemplate,
  MiniMaxMusic3Input,
  MiniMaxMusic3StepTemplate,
} from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MiniMaxMusic3Ctx = EcosystemGraphOutput & { ecosystem: 'MiniMaxMusic3' };

const SIMPLE_CHAT_MODEL = 'gpt-4o-mini';
const SIMPLE_CHAT_TEMPERATURE = 0.9;

/**
 * MiniMax reads the caption as three labelled sections; a flat style sentence
 * gets markedly weaker arrangement control, so the drafting model is told the
 * shape rather than left to invent one.
 */
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

export const createMiniMaxMusicInput = defineHandler<MiniMaxMusic3Ctx, StepInput[]>((data) => {
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
            content: `Write a song of at most ${data.duration} seconds. ${data.prompt}. Output JSON with caption and lyrics.`,
          },
        ],
        temperature: SIMPLE_CHAT_TEMPERATURE,
        responseFormat: SIMPLE_RESPONSE_FORMAT,
      } as unknown as ChatCompletionInput,
      metadata: { suppressOutput: true },
    };
    steps.push(chatStep);
  }

  // diffusionModel/textEncoder/vae are overrides on top of the recipe's own
  // weights. The ecosystem is locked to one version, so sending a partial
  // override set would only risk mismatching the recipe's text encoder and VAE.
  const musicInput = removeEmpty({
    seed: data.seed ?? Math.floor(Math.random() * maxRandomSeed),
    maxDuration: data.duration,
    ...(data.minimaxMusicMode === 'simple'
      ? {
          caption: { $ref: chatRef!, path: 'output.parsed.caption' },
          lyrics: { $ref: chatRef!, path: 'output.parsed.lyrics' },
        }
      : {
          caption: data.musicDescription,
          lyrics: data.lyrics,
        }),
  });

  const music: MiniMaxMusic3StepTemplate = {
    $type: 'miniMaxMusic3',
    input: musicInput as unknown as MiniMaxMusic3Input,
  };

  steps.push(music);
  return steps;
});
