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

import type { MiniMaxMusic3Input, MiniMaxMusic3StepTemplate } from '@civitai/client';
import { createMusicConceptStep } from '../music-concept';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MiniMaxMusic3Ctx = EcosystemGraphOutput & { ecosystem: 'MiniMaxMusic3' };

export const createMiniMaxMusicInput = defineHandler<MiniMaxMusic3Ctx, StepInput[]>((data) => {
  const steps: StepInput[] = [];

  let chatRef: string | undefined;
  if (data.minimaxMusicMode === 'simple') {
    chatRef = `$${steps.length}`;
    steps.push(createMusicConceptStep(data.prompt, data.duration));
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
