import type { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { modelsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    // Find all Upscaler model versions that have generation coverage and baseModel != 'Upscaler'
    const upscalerVersions = await dbWrite.$queryRaw<
      { modelVersionId: number; modelId: number; baseModel: string }[]
    >`
      SELECT mv.id AS "modelVersionId", m.id AS "modelId", mv."baseModel"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
      WHERE m.type = 'Upscaler'::"ModelType"
        AND mv."baseModel" != 'Upscaler'
    `;

    if (upscalerVersions.length === 0) {
      return res.status(200).json({ message: 'No upscaler versions to update', updated: 0 });
    }

    const versionIds = upscalerVersions.map((v) => v.modelVersionId);
    const modelIds = [...new Set(upscalerVersions.map((v) => v.modelId))];

    // Update baseModel to 'Upscaler' for all covered upscaler versions
    const updateResult = await dbWrite.modelVersion.updateMany({
      where: { id: { in: versionIds } },
      data: { baseModel: 'Upscaler' },
    });

    // Queue affected models for meilisearch re-indexing
    await modelsSearchIndex.queueUpdate(
      modelIds.map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );

    res.status(200).json({
      message: `Updated ${updateResult.count} upscaler versions across ${modelIds.length} models`,
      updated: updateResult.count,
      models: modelIds.length,
      sampleVersions: upscalerVersions.slice(0, 10),
    });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});
