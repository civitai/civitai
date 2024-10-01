import { ModelFlagStatus, Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetFlaggedModelsInput, ModelScanResult } from '~/server/schema/model-flag.schema';
import { getPagedData } from '~/server/utils/pagination-helpers';
import { hasNsfwWords } from '~/utils/metadata/audit';

export async function upsertModelFlag({
  modelId,
  name,
  scanResult,
  details,
}: {
  modelId: number;
  name?: string;
  scanResult?: { poi: boolean; nsfw: boolean; minor: boolean; triggerWords: boolean };
  details?: MixedObject;
}) {
  const nameNsfw = hasNsfwWords(name);
  const isFlagged = scanResult && Object.values(scanResult).some((flag) => flag);
  const status =
    nameNsfw || isFlagged
      ? Prisma.sql`${ModelFlagStatus.Pending}::"ModelFlagStatus"`
      : Prisma.sql`${ModelFlagStatus.Resolved}::"ModelFlagStatus"`;

  const [modelFlag] = await dbWrite.$queryRaw<
    {
      modelId: number;
      nameNsfw: boolean;
      poi: boolean;
      nsfw: boolean;
      minor: boolean;
      triggerWords: boolean;
      status: ModelFlagStatus;
    }[]
  >`
    INSERT INTO "ModelFlag" ("modelId", "nameNsfw", "poi", "nsfw", "minor", "triggerWords", "status", "details")
    VALUES (
      ${modelId},
      ${nameNsfw},
      ${scanResult?.poi ?? false},
      ${scanResult?.nsfw ?? false},
      ${scanResult?.minor ?? false},
      ${scanResult?.triggerWords ?? false},
      ${status},
      ${details ? Prisma.sql`${JSON.stringify(details)}::jsonb` : Prisma.JsonNull}
    )
    ON CONFLICT ("modelId") DO UPDATE
      SET "nameNsfw" = EXCLUDED."nameNsfw",
        "poi" = EXCLUDED."poi",
        "nsfw" = EXCLUDED."nsfw",
        "minor" = EXCLUDED."minor",
        "triggerWords" = EXCLUDED."triggerWords",
        "status" = EXCLUDED."status",
        "details" = EXCLUDED."details"
    RETURNING *;
  `;

  return modelFlag;
}

export function getFlaggedModels(input: GetFlaggedModelsInput) {
  return getPagedData(input, async ({ skip, take, ...rest }) => {
    const [flaggedModels, count] = await dbRead.$transaction([
      dbRead.modelFlag.findMany({
        where: { status: ModelFlagStatus.Pending },
        take,
        skip,
        select: {
          modelId: true,
          poi: true,
          nsfw: true,
          triggerWords: true,
          minor: true,
          details: true,
          model: { select: { id: true, name: true } },
        },
      }),
      dbRead.modelFlag.count({ where: { status: ModelFlagStatus.Pending } }),
    ]);

    return {
      items: flaggedModels.map(({ details, ...model }) => {
        const parsedDetails = details as ModelScanResult['llm_interrogation'];

        return {
          ...model,
          details: parsedDetails,
        };
      }),
      count,
    };
  });
}

export function resolveFlaggedModel({ id }: GetByIdInput) {
  return dbWrite.modelFlag.update({
    where: { modelId: id },
    data: { status: ModelFlagStatus.Resolved },
  });
}
