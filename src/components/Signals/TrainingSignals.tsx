import {
  useOrchestratorUpdateSignal,
  useTrainingSignals,
} from '~/components/Training/Form/TrainingCommon';

export function TrainingSignals() {
  useTrainingSignals();
  useOrchestratorUpdateSignal();
  return null;
}
