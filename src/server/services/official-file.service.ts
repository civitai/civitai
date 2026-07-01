// src/server/services/official-file.service.ts
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

// 'Checkpoint' is a valid ModelFileComponentType but never a linkable accessory
// here — treat it as "unknown" so the fallback chain keeps looking.
const asAccessory = (ct: ModelFileComponentType | null | undefined) =>
  ct && ct !== 'Checkpoint' ? ct : null;

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
  hostType,
}: {
  sha256: string;
  hostType: string;
}): Promise<OfficialFileMatch | null> {
  // Host-side weights guard — never dedup the user's primary weights. The match
  // itself is byte-identity (SHA256) only; the host's declared type does NOT gate
  // WHICH official file matches (a vague 'Other' label must still match).
  if (primaryModelFileTypes.includes(hostType as ModelFileType)) return null;

  // Matched purely on bytes + official ownership — the canonical file's own type
  // is not constrained (a standalone VAE's file is type='Model').
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

  // Component role, most-authoritative first: the official standalone model's
  // type (VAE/encoder/controlnet), then the official file's own type (for a
  // component bundled in a checkpoint), then the caller's declared host type.
  // Never trust the host label over the official file's real identity.
  const componentType =
    componentTypeFromModelType(file.modelVersion.model.type) ??
    asAccessory(inferComponentType(file.type)) ??
    asAccessory(inferComponentType(hostType));
  if (!componentType) return null; // official match isn't a linkable accessory (e.g. a checkpoint)

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
