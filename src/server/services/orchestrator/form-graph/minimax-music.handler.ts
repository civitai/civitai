/**
 * MiniMax Music 3 handler for the form-graph lane — a simple-mode
 * chatCompletion drafting caption + lyrics, then the miniMaxMusic3 step that
 * $refs (or carries) them.
 */

import type { MiniMaxMusic3Input, MiniMaxMusic3StepTemplate } from '@civitai/client';
import { createMusicConceptStep } from '../music-concept';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { StepInput } from '../ecosystems';
import type { EcosystemData } from './types';

type MiniMaxMusicData = EcosystemData<'MiniMaxMusic3'>;

export const createMiniMaxMusicInput = defineHandler<MiniMaxMusicData, StepInput[]>((data) => {
  // minimaxMusicMode picks the mode arm, so these narrow to the same split
  const simple = 'prompt' in data ? data : undefined;
  const custom = 'musicDescription' in data ? data : undefined;
  const steps: StepInput[] = [];

  let chatRef: string | undefined;
  if (data.minimaxMusicMode === 'simple') {
    chatRef = `$${steps.length}`;
    steps.push(createMusicConceptStep(simple?.prompt, data.duration));
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
