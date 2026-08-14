import { ModelFlagStatus } from '~/shared/utils/prisma/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdsInput } from '~/server/schema/base.schema';
import type { GetFlaggedModelsInput, ModelScanResult } from '~/server/schema/model-flag.schema';
import type { ModelFlagRow, ModelFlagScanResult } from '~/server/services/model-flag.sql';
import { buildModelFlagUpsert } from '~/server/services/model-flag.sql';
import { trackModActivity } from '~/server/services/moderator.service';
import { getPagedData } from '~/server/utils/pagination-helpers';

export async function upsertModelFlag({
  modelId,
  scanResult,
  details,
}: {
  modelId: number;
  scanResult?: ModelFlagScanResult;
  details?: MixedObject;
}) {
  const isFlagged = scanResult && Object.values(scanResult).some((flag) => flag);
  if (!isFlagged) return null;

  const [modelFlag] = await dbWrite.$queryRaw<ModelFlagRow[]>(
    buildModelFlagUpsert({ modelId, scanResult, details })
  );

  return modelFlag;
}

export function getFlaggedModels(input: GetFlaggedModelsInput) {
  return getPagedData(input, async ({ skip, take, sort = [] }) => {
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
          sfwOnly: true,
          details: true,
          poiName: true,
          createdAt: true,
          model: {
            select: {
              id: true,
              name: true,
              description: true,
              nsfw: true,
              poi: true,
              minor: true,
              sfwOnly: true,
              // These are needed to comply with upsert schema
              status: true,
              uploadType: true,
              type: true,
            },
          },
        },
        orderBy: [
          ...sort.map(({ id, desc }) => ({ [id]: desc ? 'desc' : 'asc' })),
          { createdAt: 'desc' },
        ],
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

export async function resolveFlaggedModel({ ids, userId }: GetByIdsInput & { userId: number }) {
  if (ids.length === 0) return null;

  const updated = await dbWrite.modelFlag.updateMany({
    where: { modelId: { in: ids } },
    data: { status: ModelFlagStatus.Resolved },
  });

  await Promise.all(
    ids.map((id) =>
      trackModActivity(userId, { entityType: 'model', entityId: id, activity: 'moderateFlag' })
    )
  ).catch((error) =>
    logToAxiom(
      {
        name: 'track-resolve-model-flag',
        type: 'error',
        message: 'Failed to track mod activity',
        error,
        details: { entityType: 'model', activity: 'moderateFlag', ids },
      },
      'moderation'
    )
  );

  return updated;
}
