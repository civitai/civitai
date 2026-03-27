import { useTextToImageSignalUpdate } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';

export function GenerationSignals() {
  useTextToImageSignalUpdate();
  return null;
}
