/**
 * MiniMax Music 3 Graph
 *
 * Controls for the MiniMax Music 3 txt2music workflow — a full song from a
 * structured caption plus lyrics.
 *
 * Modes (top-level discriminator on `minimaxMusicMode`):
 * - simple: prompt + duration. The handler emits a chatCompletion step that
 *   drafts the caption and lyrics, then $refs them into the miniMaxMusic3 step.
 * - custom: the user writes the caption (musicDescription) and lyrics directly.
 *
 * The mode exists because `MiniMaxMusic3Input` requires BOTH `caption` and
 * `lyrics` — unlike ACE, where lyrics are optional, there is no way to submit
 * this model without a full lyric sheet.
 *
 * `cfg`, `steps` and `topK` are deliberately absent: the step input marks them
 * optional and no published source gives authoritative ranges, so the
 * orchestrator's defaults stand rather than ranges we invented.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { createCheckpointGraph, createTextEditorGraph, seedNode, sliderNode } from './common';

export type MinimaxMusicMode = 'simple' | 'custom';

const minimaxMusicModeOptions = [
  { label: 'Simple', value: 'simple' as const },
  { label: 'Custom', value: 'custom' as const },
];

export const minimaxMusicVersionIds = {
  'v3.0': 3225593,
} as const;

/**
 * The model caps generation at 9,000 acoustic frames at 25fps — 360s — but the
 * card and the reference workflow both stop at "up to five minutes", so 300 is
 * the ceiling we offer. 60 matches the ComfyUI template's default.
 */
const MINIMAX_MUSIC_MIN_DURATION = 30;
const MINIMAX_MUSIC_MAX_DURATION = 300;
const MINIMAX_MUSIC_DEFAULT_DURATION = 60;

const MAX_CAPTION_LENGTH = 2000;

type MinimaxMusicModeCtx = {
  ecosystem: string;
  workflow: string;
  minimaxMusicMode: MinimaxMusicMode;
};

const minimaxMusicSimpleGraph = new DataGraph<MinimaxMusicModeCtx, GenerationCtx>().merge(
  createTextEditorGraph({
    name: 'prompt',
    required: true,
    placeholder: 'Describe the song you want to generate...',
    info: 'In simple mode your prompt is sent to a chat model that drafts the structured music description and the lyrics for you. Describe the song concept in plain English.',
  })
);

const minimaxMusicCustomGraph = new DataGraph<MinimaxMusicModeCtx, GenerationCtx>()
  .merge(
    () =>
      createTextEditorGraph({
        name: 'musicDescription',
        required: true,
        emptyMessage: 'Music description is required',
        maxLength: MAX_CAPTION_LENGTH,
      }),
    []
  )
  .merge(
    () =>
      createTextEditorGraph({
        name: 'lyrics',
        required: true,
        emptyMessage: 'Lyrics are required',
      }),
    []
  );

type MinimaxMusicCtx = { ecosystem: string; workflow: string };

export const minimaxMusicGraph = new DataGraph<MinimaxMusicCtx, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        versions: {
          options: [{ label: 'v3.0', value: minimaxMusicVersionIds['v3.0'] }],
        },
        defaultModelId: minimaxMusicVersionIds['v3.0'],
      }),
    []
  )

  .node('seed', seedNode())

  // A cap, not a target — the model ends early once the lyric structure completes.
  // sliderNode, not a hand-rolled min/max: it clamps, so a duration carried over
  // from a video ecosystem cannot fail validation with nothing on screen to say why.
  .node(
    'duration',
    sliderNode({
      min: MINIMAX_MUSIC_MIN_DURATION,
      max: MINIMAX_MUSIC_MAX_DURATION,
      defaultValue: MINIMAX_MUSIC_DEFAULT_DURATION,
      step: 10,
    })
  )

  .node('minimaxMusicMode', {
    input: z.enum(['simple', 'custom']).optional(),
    output: z.enum(['simple', 'custom']),
    defaultValue: 'simple',
    meta: {
      options: minimaxMusicModeOptions,
    },
  })

  .discriminator('minimaxMusicMode', {
    simple: minimaxMusicSimpleGraph,
    custom: minimaxMusicCustomGraph,
  });

export {
  MINIMAX_MUSIC_MIN_DURATION,
  MINIMAX_MUSIC_MAX_DURATION,
  MINIMAX_MUSIC_DEFAULT_DURATION,
  minimaxMusicModeOptions,
};
