import { dbRead } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { inferComponentType } from '~/server/utils/model-helpers';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import { ModelHashType } from '~/shared/utils/prisma/enums';
import type { ModelFileType } from '~/server/common/constants';

const OFFICIAL_USER_ID = constants.system.officialUserId;

// The dedicated standalone Model.type → the component role it represents. This
// is authoritative for a standalone VAE/encoder/controlnet whose file is stored
// as type='Model' (so inferComponentType on the file would wrongly say 'Checkpoint').
function componentTypeFromModelType(modelType: string): ModelFileComponentType | null {
  switch (modelType) {
    case 'VAE':
      return 'VAE';
    case 'TextEncoder':
      return 'TextEncoder';
    case 'Controlnet':
      return 'ControlNet';
    default:
      return null;
  }
}

// A file/host type maps to a linkable accessory componentType — or null if it is
// PRIMARY WEIGHTS (Model / Pruned Model / Diffusion Model / UNet), which must never
// be deduped. inferComponentType alone is not enough: it maps 'Diffusion Model' →
// 'DiffusionModel' and 'UNet' → 'UNet', which would wrongly look like accessories.
function accessoryComponentType(fileType: string): ModelFileComponentType | null {
  if (primaryModelFileTypes.includes(fileType as ModelFileType)) return null;
  return inferComponentType(fileType);
}

export type OfficialFileMatch = {
  versionId: number;
  fileId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  fileName: string;
  sizeKB: number;
  componentType: ModelFileComponentType;
};

export async function findOfficialFilesBySize(sizeKB: number): Promise<{ id: number }[]> {
  return dbRead.modelFile.findMany({
    where: { sizeKB, modelVersion: { model: { userId: OFFICIAL_USER_ID } } },
    select: { id: true },
  });
}

export async function findOfficialFileByHash({
  sha256,
}: {
  sha256: string;
}): Promise<OfficialFileMatch | null> {
  // Matched on byte identity (SHA256) + official ownership only — no reliance on
  // the caller's declared file type, so a mislabelled file (or one dropped in the
  // main file section) is checked too and can't be used to bypass dedup. Genuine
  // primary weights are safe: an official checkpoint / primary-weights match
  // yields no componentType below, so it is never linked (only accessories are).
  // Callers that delete the host row (via replaceFileId) must still skip primary
  // types themselves — addLinkedComponent refuses to delete primary weights.
  const file = await dbRead.modelFile.findFirst({
    where: {
      hashes: { some: { type: ModelHashType.SHA256, hash: sha256.toUpperCase() } }, // stored ModelFileHash.hash is UPPERCASE hex
      modelVersion: { model: { userId: OFFICIAL_USER_ID } },
    },
    orderBy: { modelVersionId: 'asc' },
    select: {
      id: true,
      name: true,
      sizeKB: true,
      type: true,
      modelVersionId: true,
      modelVersion: {
        select: { name: true, modelId: true, model: { select: { name: true, type: true } } },
      },
    },
  });
  if (!file) return null;

  // Component role from the official file's own identity: the standalone model's
  // type (VAE/encoder/controlnet), else the file's own type (a component bundled
  // in a checkpoint). Null → not a linkable accessory (a checkpoint / primary
  // weights), so it is never linked.
  const componentType =
    componentTypeFromModelType(file.modelVersion.model.type) ?? accessoryComponentType(file.type);
  if (!componentType) return null;

  return {
    versionId: file.modelVersionId,
    fileId: file.id,
    modelId: file.modelVersion.modelId,
    modelName: file.modelVersion.model.name,
    versionName: file.modelVersion.name,
    fileName: file.name,
    sizeKB: file.sizeKB,
    componentType,
  };
}
