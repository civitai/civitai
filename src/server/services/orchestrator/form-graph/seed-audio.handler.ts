import { defineHandler } from '../handlers/handler-factory';
import type { StepInput } from '../handlers';
import type { EcosystemData } from './types';

// @civitai/orchestration-client 0.2.9 predates the seedAudioGen step; shape from the orchestrator's
// OpenAPI SeedAudioGenerateInput.
type SeedAudioGenerateInput = {
  operation: 'generate';
  prompt: string;
  referenceImage?: string | null;
};

export const createSeedAudioInput = defineHandler<EcosystemData<'SeedAudio'>, StepInput[]>(
  (data) => {
    const input: SeedAudioGenerateInput = {
      operation: 'generate',
      prompt: data.prompt,
      referenceImage: data.images?.[0]?.url ?? null,
    };
    return [{ $type: 'seedAudioGen', input } as unknown as StepInput];
  }
);
