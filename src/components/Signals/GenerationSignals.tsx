import { useTextToImageSignalUpdate } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import {
  useWorkflowUpdateSignal,
  useWorkflowPolling,
} from '~/components/Orchestrator/workflowHooks';

export function GenerationSignals() {
  useTextToImageSignalUpdate();
  useWorkflowUpdateSignal();
  useWorkflowPolling();
  return null;
}
