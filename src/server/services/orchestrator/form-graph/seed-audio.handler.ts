import { defineHandler } from '../handlers/handler-factory';
import type { StepInput } from '../handlers';
import type { EcosystemData } from './types';

// @civitai/orchestration-client has no seedAudioGen type yet; drop this for its type once it ships.
// Shape from the orchestrator's OpenAPI SeedAudioGenerateInput.
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
