import { getPrimaryFile } from '~/server/utils/model-helpers';
import { stringifyAIR } from '~/shared/utils/air';
import type { ModelType } from '~/shared/utils/prisma/enums';

export type ModelVersionAirInput = {
  id: number;
  baseModel: string;
  model: { id: number; type: ModelType };
  files?: { type: string; metadata: BasicFileMetadata }[] | null;
};

/** Passing `files` can change the AIR (a Checkpoint whose primary file is a diffusion model / UNET
 *  advertises that kind — see `fileTypeUrnMap`), so a caller with files and one without are asking
 *  about different resources. */
export function modelVersionToAir({ id, baseModel, model, files }: ModelVersionAirInput) {
  const primaryFile = files?.length ? getPrimaryFile(files) : undefined;
  return stringifyAIR({
    baseModel,
    type: model.type,
    modelId: model.id,
    id,
    fileType: primaryFile?.type,
  });
}
