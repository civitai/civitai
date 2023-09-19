import { useImageGenStatusUpdate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useTrainingSignals } from '~/components/Resource/Forms/Training/TrainingCommon';

export function SignalsRegistrar() {
  useImageGenStatusUpdate();
  useTrainingSignals();

  return null;
}
