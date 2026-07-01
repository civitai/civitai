// src/server/services/official-file.service.ts
import { dbRead } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { inferComponentType } from '~/server/utils/model-helpers';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import { ModelHashType } from '~/shared/utils/prisma/enums';
import type { ModelFileType } from '~/server/common/constants';

const OFFICIAL_USER_ID = constants.system.officialUserId;

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
  // Host-side weights guard — never dedup the user's primary weights.
  if (primaryModelFileTypes.includes(hostType as ModelFileType)) return null;
  const componentType = inferComponentType(hostType);
  if (!componentType) return null;

  // Canonical is matched purely on bytes + official ownership — its own file
  // type is not constrained (a standalone VAE's file is type='Model').
  const file = await dbRead.modelFile.findFirst({
    where: {
      hashes: { some: { type: ModelHashType.SHA256, hash: sha256.toLowerCase() } },
      modelVersion: { model: { userId: OFFICIAL_USER_ID } },
    },
    orderBy: { modelVersionId: 'asc' },
    select: {
      id: true,
      name: true,
      sizeKB: true,
      modelVersionId: true,
      modelVersion: { select: { name: true, modelId: true, model: { select: { name: true } } } },
    },
  });
  if (!file) return null;

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
