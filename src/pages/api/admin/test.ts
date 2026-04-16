import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const modelVersionId = 2514310;

    const modelVersion = await dbRead.modelVersion.findUnique({
      where: { id: modelVersionId },
      select: {
        id: true,
        baseModel: true,
        model: { select: { id: true, type: true } },
        files: { select: { id: true, name: true } },
      },
    });

    if (!modelVersion)
      return res.status(404).json({ error: `ModelVersion ${modelVersionId} not found` });
    if (modelVersion.files.length === 0)
      return res.status(404).json({ error: `No files found for modelVersion ${modelVersionId}` });

    const results = await Promise.all(
      modelVersion.files.map(async (file) => {
        try {
          const response = await createModelFileScanRequest({
            fileId: file.id,
            modelVersionId: modelVersion.id,
            modelId: modelVersion.model.id,
            modelType: modelVersion.model.type,
            baseModel: modelVersion.baseModel,
          });
          return { fileId: file.id, fileName: file.name, ok: true, response };
        } catch (err) {
          return {
            fileId: file.id,
            fileName: file.name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    res.status(200).json({ modelVersionId, results });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});
