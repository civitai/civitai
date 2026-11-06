import { dbWrite } from '~/server/db/client';
import { bustOrchestratorScannedFileCache } from '~/server/services/orchestrator/models';
import type { ModelType } from '~/shared/utils/prisma/enums';

/** Busts the file-pinned AIR of every file of the version; version busts never reach them. */
export async function bustVersionScannedFileAirs(
  modelVersionId: number,
  version: { modelId: number; baseModel: string; model: { type: ModelType } }
) {
  const files = await dbWrite.modelFile.findMany({
    where: { modelVersionId },
    select: { id: true },
  });
  await Promise.all(
    files.map(({ id }) =>
      bustOrchestratorScannedFileCache({
        fileId: id,
        modelVersionId,
        modelId: version.modelId,
        modelType: version.model.type,
        baseModel: version.baseModel,
      })
    )
  );
}
