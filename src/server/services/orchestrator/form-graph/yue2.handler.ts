import type { YuE2StepTemplate } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import { yue2Steps } from '~/shared/constants/yue2.constants';
import { createMusicConceptStep } from '../music-concept';
import { defineHandler } from '../ecosystems/handler-factory';
import type { StepInput } from '../ecosystems';
import type { EcosystemData } from './types';

export const createYuE2Input = defineHandler<EcosystemData<'YuE2'>, StepInput[]>((data) => {
  const shared = {
    maxDuration: data.duration,
    seed: data.seed ?? Math.floor(Math.random() * maxRandomSeed),
  };

  if ('prompt' in data) {
    const music: YuE2StepTemplate = {
      $type: 'yuE2',
      input: {
        ...shared,
        // The orchestrator resolves template references before validating YuE2Input;
        // the generated client only describes the resolved string fields.
        style: { $ref: '$0', path: 'output.parsed.caption' } as unknown as string,
        lyrics: { $ref: '$0', path: 'output.parsed.lyrics' } as unknown as string,
        steps: yue2Steps.default,
        mode: 'full',
      },
    };
    return [createMusicConceptStep(data.prompt, data.duration), music];
  }

  return [
    {
      $type: 'yuE2',
      input: {
        ...shared,
        style: data.musicDescription,
        lyrics: data.lyrics,
        steps: data.steps,
        mode: data.yue2Mode,
        abc: data.yue2Mode !== 'off' ? data.yue2Abc?.trim() || undefined : undefined,
      },
    },
  ];
});
