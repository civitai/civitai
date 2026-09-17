import {
  getBaseModelsByEcosystemId,
  getRootEcosystem,
} from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config/workflows';
import {
  getEcosystemByAirSegment,
  parseRawAirResourceUrn,
  rawAirGenerationResource,
  rawAirResourceId,
} from '~/shared/utils/air';
import { generationGraphStore } from '~/store/generation-graph.store';

export interface RawAirSeedRequest {
  air: string;
  workflowId: string;
  name?: string | null;
}

/**
 * Seed the generator with a raw orchestrator blob AIR — a training epoch's
 * weights, no ModelVersion row. The workflowId names the training run the
 * server verifies ownership against. Shared by the `/generate?air=` deep link
 * and the embedded Training Studio's in-place handoff. Returns false when the
 * AIR doesn't resolve to a generatable ecosystem.
 */
export function seedRawAirResource({ air, workflowId, name }: RawAirSeedRequest): boolean {
  const parsed = parseRawAirResourceUrn(air);
  if (!parsed) return false;
  const airEco = getEcosystemByAirSegment(parsed.ecosystem);
  if (!airEco) return false;

  // Land on the AIR's own ecosystem when the graph generates with it
  // directly; otherwise roll a child key (e.g. flux2klein) up to its root.
  const formEco = isWorkflowAvailable('txt2img', airEco.id) ? airEco : getRootEcosystem(airEco.key);
  const baseModel = getBaseModelsByEcosystemId(formEco.id)[0]?.name;
  if (!baseModel) return false;

  const resource = rawAirGenerationResource({
    id: rawAirResourceId(air),
    air,
    workflowId,
    name,
    baseModel,
  });

  generationGraphStore.setData({
    params: { ecosystem: formEco.key },
    resources: [resource],
    runType: 'run',
  });
  return true;
}
