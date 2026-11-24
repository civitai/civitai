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
 * Whether a submit's output is held to PG-13 with mature content refused: the caller flags a
 * private generation, the `workflow` is `sfwOnly` (avatars, which depict a real person), the
 * ecosystem restricts it, or any resource's base model does. The ecosystem counts even with
 * resources, so a request on a restricted ecosystem stays capped whatever its resources are
 * labelled, raw-AIR epochs (which carry no base model) included.
 */
export function capsGenerationOutput({
  isPrivateGeneration = false,
  workflow,
  baseModels,
  ecosystem,
}: {
  isPrivateGeneration?: boolean;
  workflow?: string;
  baseModels: (string | undefined)[];
  ecosystem?: string;
}) {
  if (isPrivateGeneration) return true;
  if (workflow && workflowConfigByKey.get(workflow)?.sfwOnly) return true;
  const record = ecosystem ? ecosystemByKey.get(ecosystem) : undefined;
  if (record && ecosystemRestrictsGeneration(record)) return true;
  return baseModels.some(restrictsGeneration);
}

/**
 * The maturity fields of a submit body: the cap when `capOutput`, else the caller's refusal. A
 * submit never asks for mature content outright; the orchestrator decides it when the flag is unset.
 */
export function outputRestrictions(capOutput: boolean, allowMatureContent: boolean | undefined) {
  if (capOutput) return { nsfwLevel: 'pg13' as const, allowMatureContent: false };
  return allowMatureContent === false ? { allowMatureContent: false } : {};
}
