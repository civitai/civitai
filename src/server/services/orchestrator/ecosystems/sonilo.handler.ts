import type {
  SoniloAudioGenStepTemplate,
  SoniloMusicInput,
  SoniloSoundEffectInput,
} from '@civitai/orchestration-client';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

type SoniloCtx = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }> & {
  ecosystem: 'Sonilo';
};

export const createSoniloInput = defineHandler<SoniloCtx, [SoniloAudioGenStepTemplate]>((data) => {
  const input: SoniloMusicInput | SoniloSoundEffectInput = {
    operation: data.soniloOperation,
    prompt: data.prompt,
    duration: data.duration,
  };
  return [{ $type: 'soniloAudioGen', input }];
});
