import type { ChatCompletionStepTemplate } from '@civitai/client';

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

/** Shared Simple-mode drafting contract for music models requiring description + lyrics. */
export function createMusicConceptStep(
  prompt: string | undefined,
  duration: number
): ChatCompletionStepTemplate {
  const messages = [
    { role: 'system', content: SIMPLE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Write a song of at most ${duration} seconds. ${prompt}. Output JSON with caption and lyrics.`,
    },
  ];
  return {
    $type: 'chatCompletion',
    input: {
      model: SIMPLE_CHAT_MODEL,
      messages,
      temperature: SIMPLE_CHAT_TEMPERATURE,
      responseFormat: SIMPLE_RESPONSE_FORMAT,
    },
    metadata: { suppressOutput: true },
  };
}
