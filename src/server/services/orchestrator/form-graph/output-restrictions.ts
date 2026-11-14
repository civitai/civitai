import {
  ecosystemByKey,
  getBaseModelsByEcosystemId,
  isMatureRestricted,
} from '~/shared/constants/basemodel.constants';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';

/**
 * Whether a submit's base models restrict mature generation. A submit with no resources (an edit
 * that runs the ecosystem's own weights) is decided by its ecosystem, and only when every base
 * model in it restricts generation: SDXL holds SDXL Turbo but is not restricted.
 */
export function capsGenerationOutput({
  baseModels,
  ecosystem,
}: {
  baseModels: (string | undefined)[];
  ecosystem?: string;
}) {
  if (baseModels.length > 0) return baseModels.some((bm) => isMatureRestricted(bm, 'generation'));
  const record = ecosystem ? ecosystemByKey.get(ecosystem) : undefined;
  const bases = record ? getBaseModelsByEcosystemId(record.id) : [];
  return bases.length > 0 && bases.every((m) => isMatureRestricted(m.name, 'generation'));
}

/**
 * The orchestrator's output cap for a submit. Private generation, `sfwOnly` workflows (avatars,
 * which depict a real person) and base models that restrict mature generation are held to PG-13
 * with mature content refused; everything else keeps the caller's choice.
 */
export function workflowOutputRestrictions({
  workflow,
  isPrivateGeneration,
  capOutput,
  allowMatureContent,
}: {
  workflow: string;
  isPrivateGeneration: boolean;
  capOutput: boolean;
  allowMatureContent?: boolean;
}) {
  if (isPrivateGeneration || capOutput || workflowConfigByKey.get(workflow)?.sfwOnly)
    return { nsfwLevel: 'pg13' as const, allowMatureContent: false };
  return { nsfwLevel: undefined, allowMatureContent };
}
