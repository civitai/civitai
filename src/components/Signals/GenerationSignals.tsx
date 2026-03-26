import { useTextToImageSignalUpdate } from '~/components/ImageGeneration/utils/useGenerationSignalUpdate';
import { useWorkflowUpdateSignal } from '~/components/Orchestrator/workflowHooks';

export function GenerationSignals() {
  useTextToImageSignalUpdate();
  useWorkflowUpdateSignal();
  return null;
}
