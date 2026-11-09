import {
  baseModelByName,
  ecosystemByKey,
  getBaseModelLicense,
  getBaseModelsByEcosystemId,
  type EcosystemRecord,
} from '~/shared/constants/basemodel.constants';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';
import { getEcosystemByAirSegment, parseRawAirResourceUrn } from '~/shared/utils/air';

const licenseCapsOutput = (baseModelId: number) =>
  !!getBaseModelLicense(baseModelId)?.capGenerationOutput;

const ecosystemCapsOutput = (ecosystem: EcosystemRecord) =>
  getBaseModelsByEcosystemId(ecosystem.id).some((m) => licenseCapsOutput(m.id));

/**
 * Whether a submit must be held to the capped output level because a licence on one of its base
 * models requires it. Checks the resources' base models, each raw-AIR epoch's ecosystem (an epoch
 * has no base model of its own), and the request's ecosystem, which covers submits that carry no
 * resource at all, such as an edit that always runs the official weights.
 *
 * A raw AIR whose ecosystem cannot be resolved counts as capped.
 */
export function capsGenerationOutput({
  baseModels,
  rawAirs,
  requestEcosystem,
}: {
  baseModels: (string | undefined)[];
  rawAirs: string[];
  requestEcosystem?: string;
}) {
  if (baseModels.some((name) => !!name && licenseCapsOutput(baseModelByName.get(name)?.id ?? -1)))
    return true;
  const rawAirCapped = rawAirs.some((air) => {
    const segment = parseRawAirResourceUrn(air)?.ecosystem;
    const ecosystem = segment ? getEcosystemByAirSegment(segment) : undefined;
    return !ecosystem || ecosystemCapsOutput(ecosystem);
  });
  if (rawAirCapped) return true;
  const ecosystem = requestEcosystem ? ecosystemByKey.get(requestEcosystem) : undefined;
  return !!ecosystem && ecosystemCapsOutput(ecosystem);
}

/**
 * The orchestrator's output cap for a submit. Private generation, `sfwOnly` workflows (avatars,
 * which depict a real person) and submits on a base model whose licence caps output are held to
 * PG-13 with mature content refused; everything else keeps the caller's choice.
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
