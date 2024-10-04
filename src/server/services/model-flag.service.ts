import { ModelFlagStatus, Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetFlaggedModelsInput, ModelScanResult } from '~/server/schema/model-flag.schema';
import { trackModActivity } from '~/server/services/moderator.service';
import { getPagedData } from '~/server/utils/pagination-helpers';

export async function upsertModelFlag({
  modelId,
  scanResult,
  details,
}: {
  modelId: number;
  poiName?: string;
  scanResult?: {
    poi: boolean;
    nsfw: boolean;
    minor: boolean;
    triggerWords: boolean;
    poiName: boolean;
  };
  details?: MixedObject;
}) {
  const isFlagged = scanResult && Object.values(scanResult).some((flag) => flag);
  if (!isFlagged) return null;

  const [modelFlag] = await dbWrite.$queryRaw<
    {
      modelId: number;
      poi: boolean;
      nsfw: boolean;
      minor: boolean;
      triggerWords: boolean;
      poiName: string | null;
      status: ModelFlagStatus;
    }[]
  >`
    INSERT INTO "ModelFlag" ("modelId", "poi", "nsfw", "minor", "triggerWords", "poiName", "status", "details")
    VALUES (
      ${modelId},
      ${scanResult?.poi ?? false},
      ${scanResult?.nsfw ?? false},
      ${scanResult?.minor ?? false},
      ${scanResult?.triggerWords ?? false},
      ${scanResult?.poiName ?? false},
      ${Prisma.sql`${ModelFlagStatus.Pending}::"ModelFlagStatus"`},
      ${details ? Prisma.sql`${JSON.stringify(details)}::jsonb` : Prisma.JsonNull}
    )
    ON CONFLICT ("modelId") DO UPDATE
      SET "poi" = EXCLUDED."poi",
        "nsfw" = EXCLUDED."nsfw",
        "minor" = EXCLUDED."minor",
        "triggerWords" = EXCLUDED."triggerWords",
        "poiName" = EXCLUDED."poiName",
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
          poiName: true,
          model: {
            select: {
              id: true,
              name: true,
              description: true,
              nsfw: true,
              poi: true,
              minor: true,
              // These are needed to comply with upsert schema
              status: true,
              uploadType: true,
              type: true,
            },
          },
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

export async function resolveFlaggedModel({ id, userId }: GetByIdInput & { userId: number }) {
  const updated = await dbWrite.modelFlag.update({
    where: { modelId: id },
    data: { status: ModelFlagStatus.Resolved },
  });

  await trackModActivity(userId, { entityType: 'model', entityId: id, activity: 'moderateFlag' });

  return updated;
}
