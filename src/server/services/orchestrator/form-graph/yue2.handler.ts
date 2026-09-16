import type { YuE2StepTemplate } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

export const createYuE2Input = defineHandler<EcosystemData<'YuE2'>, [YuE2StepTemplate]>((data) => [
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
