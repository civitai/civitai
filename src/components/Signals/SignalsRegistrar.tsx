import { useImageGenStatusUpdate } from '~/components/ImageGeneration/utils/generationRequestHooks';

export function SignalsRegistrar() {
  useImageGenStatusUpdate();

  return null;
}
