import { DataGraph } from '~/libs/data-graph/data-graph';
import { yue2Duration, yue2ModeOptions, yue2Steps } from '~/shared/constants/yue2.constants';
import type { GenerationCtx } from './context';
import { enumNode, seedNode, sliderNode, textNode } from './common';

export const yue2Graph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .node(
    'musicDescription',
    textNode({
      name: 'musicDescription',
      required: true,
      emptyMessage: 'Music description is required',
    })
  )
  .node('lyrics', textNode({ name: 'lyrics', required: true, emptyMessage: 'Lyrics are required' }))
  .node('duration', sliderNode({ ...yue2Duration, defaultValue: yue2Duration.default }))
  .node('steps', sliderNode({ ...yue2Steps, defaultValue: yue2Steps.default }))
  .node('seed', seedNode())
  .node('yue2Mode', enumNode({ options: yue2ModeOptions, defaultValue: 'full' }))
  .node('yue2Abc', (ctx) => ({ ...textNode({ name: 'yue2Abc' }), when: ctx.yue2Mode !== 'off' }), [
    'yue2Mode',
  ]);
