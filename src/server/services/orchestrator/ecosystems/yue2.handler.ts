import type { YuE2StepTemplate } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

type YuE2Ctx = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }> & { ecosystem: 'YuE2' };

export const createYuE2Input = defineHandler<YuE2Ctx, [YuE2StepTemplate]>((data) => [
  {
    $type: 'yuE2',
    input: {
      style: data.musicDescription,
      lyrics: data.lyrics,
      maxDuration: data.duration,
      steps: data.steps,
      seed: data.seed ?? Math.floor(Math.random() * maxRandomSeed),
      mode: data.yue2Mode,
      abc: data.yue2Mode !== 'off' ? data.yue2Abc?.trim() || undefined : undefined,
    },
  },
]);
