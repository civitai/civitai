import { DataGraph } from '~/libs/data-graph/data-graph';
import {
  soniloDuration,
  soniloOperationOptions,
  soniloVersionIds,
  SONILO_MAX_PROMPT_LENGTH,
  type SoniloOperation,
} from '~/shared/constants/sonilo.constants';
import type { GenerationCtx } from './context';
import { createCheckpointGraph, createTextEditorGraph, enumNode, sliderNode } from './common';

type SoniloOperationCtx = { ecosystem: string; workflow: string; soniloOperation: SoniloOperation };

const soniloMusicGraph = new DataGraph<SoniloOperationCtx, GenerationCtx>().node(
  'duration',
  sliderNode({ ...soniloDuration.music, defaultValue: soniloDuration.music.default })
);

const soniloSoundEffectGraph = new DataGraph<SoniloOperationCtx, GenerationCtx>().node(
  'duration',
  sliderNode({ ...soniloDuration.soundEffect, defaultValue: soniloDuration.soundEffect.default })
);

type SoniloCtx = { ecosystem: string; workflow: string };

export const soniloGraph = new DataGraph<SoniloCtx, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: [{ label: 'V1.1', value: soniloVersionIds['V1.1'] }] },
        defaultModelId: soniloVersionIds['V1.1'],
      }),
    []
  )
  .merge(
    () =>
      createTextEditorGraph({
        name: 'prompt',
        required: true,
        maxLength: SONILO_MAX_PROMPT_LENGTH,
      }),
    []
  )
  .node('soniloOperation', enumNode({ options: soniloOperationOptions, defaultValue: 'music' }))
  .discriminator('soniloOperation', {
    music: soniloMusicGraph,
    soundEffect: soniloSoundEffectGraph,
  });
