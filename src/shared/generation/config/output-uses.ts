import type { OutputUse } from './types';
import { workflowConfigByKey } from './workflows';

/**
 * Whether an output of `workflow` can be used for `use`, from that workflow's `outputUses`. Read
 * from the saved workflow key rather than stamped on at submit, so a config change also applies to
 * outputs made before it. An output of a workflow with no config (older generations) can be used
 * for anything.
 */
export function canUseWorkflowOutput(workflow: unknown, use: OutputUse) {
  const config = typeof workflow === 'string' ? workflowConfigByKey.get(workflow) : undefined;
  return !config || config.outputUses.includes(use);
}
