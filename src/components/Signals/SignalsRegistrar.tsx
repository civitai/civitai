import { useImageGenStatusUpdate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useTrainingSignals } from '~/components/Resource/Forms/Training/TrainingCommon';
import { useBuzzSignalUpdate } from '~/components/Buzz/useBuzz';

export function SignalsRegistrar() {
  useImageGenStatusUpdate();
  useTrainingSignals();
  useBuzzSignalUpdate();

  return null;
}
