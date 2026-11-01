import { stringifyAIR } from '~/shared/utils/air';
import type { ModelType } from '~/shared/utils/prisma/enums';

export type ModelFileScanAirInput = {
  fileId: number;
  modelVersionId: number;
  modelId: number;
  modelType: ModelType;
  baseModel: string;
};

/** The AIR a model-file scan submits: pinned to the file and without its kind. The orchestrator
 *  caches per exact AIR string, so a bust of the scan's cached answer must send this same string. */
export function modelFileScanAir({
  fileId,
  modelVersionId,
  modelId,
  modelType,
  baseModel,
}: ModelFileScanAirInput) {
  return stringifyAIR({ baseModel, type: modelType, modelId, id: modelVersionId, fileId });
}
