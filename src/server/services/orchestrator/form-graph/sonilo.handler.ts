import type {
  SoniloAudioGenStepTemplate,
  SoniloMusicInput,
  SoniloSoundEffectInput,
} from '@civitai/orchestration-client';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

export const createSoniloInput = defineHandler<
  EcosystemData<'Sonilo'>,
  [SoniloAudioGenStepTemplate]
>((data) => {
  const input: SoniloMusicInput | SoniloSoundEffectInput = {
    operation: data.soniloOperation,
    prompt: data.prompt,
    duration: data.duration,
  };
  return [{ $type: 'soniloAudioGen', input }];
});
