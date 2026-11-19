import {
  ecosystemByKey,
  getBaseModelsByEcosystemId,
  isMatureRestricted,
  type EcosystemRecord,
} from '~/shared/constants/basemodel.constants';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';

const restrictsGeneration = (baseModel: string | undefined) =>
  isMatureRestricted(baseModel, 'generation');

// SDXL holds SDXL Turbo but is not restricted: an ecosystem restricts only when every base in it does.
const ecosystemRestrictsGeneration = (ecosystem: EcosystemRecord) => {
  const bases = getBaseModelsByEcosystemId(ecosystem.id);
  return bases.length > 0 && bases.every((m) => restrictsGeneration(m.name));
};

/**
 * Whether a submit restricts mature generation: its ecosystem does, or any resource's base model.
 * The ecosystem counts even with resources, so a request on a restricted ecosystem stays capped
 * whatever its resources are labelled, raw-AIR epochs (which carry no base model) included.
 */
export function capsGenerationOutput({
  baseModels,
  ecosystem,
}: {
  baseModels: (string | undefined)[];
  ecosystem?: string;
}) {
  const record = ecosystem ? ecosystemByKey.get(ecosystem) : undefined;
  if (record && ecosystemRestrictsGeneration(record)) return true;
  return baseModels.some(restrictsGeneration);
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
