import { dbWrite } from '~/server/db/client';
import { bustOrchestratorScannedFileCache } from '~/server/services/orchestrator/models';
import type { ModelType } from '~/shared/utils/prisma/enums';

/**
 * Busts the file-pinned AIR of every file of the version; version busts never reach them.
 * `goneFileIds`: files no longer on the version (replaced, or moved to another), whose AIR under it
 * may still be cached.
 */
export async function bustVersionScannedFileAirs(
  modelVersionId: number,
  version: { modelId: number; baseModel: string; model: { type: ModelType } },
  goneFileIds: number[] = []
) {
  const files = await dbWrite.modelFile.findMany({
    where: { modelVersionId },
    select: { id: true },
  });
  const fileIds = new Set([...files.map(({ id }) => id), ...goneFileIds]);
  await Promise.all(
    [...fileIds].map((id) =>
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
