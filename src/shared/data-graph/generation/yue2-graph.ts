import { DataGraph } from '~/libs/data-graph/data-graph';
import {
  yue2Duration,
  yue2ModeOptions,
  yue2MusicModeOptions,
  yue2Steps,
} from '~/shared/constants/yue2.constants';
import type { GenerationCtx } from './context';
import {
  createCheckpointGraph,
  createTextEditorGraph,
  enumNode,
  seedNode,
  sliderNode,
  textNode,
} from './common';

export const yue2VersionIds = { v2: 3337846 } as const;

type YuE2ModeCtx = {
  ecosystem: string;
  workflow: string;
  yue2MusicMode: 'simple' | 'custom';
};

const simple = new DataGraph<YuE2ModeCtx, GenerationCtx>().merge(
  createTextEditorGraph({
    name: 'prompt',
    required: true,
    placeholder: 'Describe the song you want to generate...',
    info: 'Describe the song concept in plain English — a chat model drafts the music description and lyrics for you.',
  })
);

const custom = new DataGraph<YuE2ModeCtx, GenerationCtx>()
  .node(
    'musicDescription',
    textNode({
      name: 'musicDescription',
      required: true,
      emptyMessage: 'Music description is required',
    })
  )
  .node('lyrics', textNode({ name: 'lyrics', required: true, emptyMessage: 'Lyrics are required' }))
  .node('steps', sliderNode({ ...yue2Steps, defaultValue: yue2Steps.default }))
  .node('yue2Mode', enumNode({ options: yue2ModeOptions, defaultValue: 'full' }))
  .node('yue2Abc', (ctx) => ({ ...textNode({ name: 'yue2Abc' }), when: ctx.yue2Mode !== 'off' }), [
    'yue2Mode',
  ]);

export const yue2Graph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: [{ label: 'v2', value: yue2VersionIds.v2 }] },
        defaultModelId: yue2VersionIds.v2,
      }),
    []
  )
  .node('duration', sliderNode({ ...yue2Duration, defaultValue: yue2Duration.default }))
  .node('seed', seedNode())
  .node('yue2MusicMode', enumNode({ options: yue2MusicModeOptions, defaultValue: 'simple' }))
  .discriminator('yue2MusicMode', { simple, custom });
