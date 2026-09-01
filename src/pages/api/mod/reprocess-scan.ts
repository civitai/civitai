import type { NextApiRequest, NextApiResponse } from 'next';
import { normalizeScanHashes } from '~/server/services/model-file-scan.service';
import { dbWrite } from '~/server/db/client';
import * as z from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { Prisma } from '@prisma/client';
import { ModelHashType } from '~/shared/utils/prisma/enums';

const stringToNumberArraySchema = z
  .string()
  .transform((s) => s.split(',').map(Number))
  .optional();
const importSchema = z.object({
  modelIds: stringToNumberArraySchema,
  modelVersionIds: stringToNumberArraySchema,
  modelFileIds: stringToNumberArraySchema,
});

export default ModEndpoint(
  async function reprocessHashes(req: NextApiRequest, res: NextApiResponse) {
    const { modelIds, modelVersionIds, modelFileIds } = importSchema.parse(req.query);

    const OR: Prisma.Enumerable<Prisma.ModelFileWhereInput> = [];
    if (!!modelFileIds?.length) OR.push({ id: { in: modelFileIds } });
    if (!!modelVersionIds?.length) OR.push({ modelVersionId: { in: modelVersionIds } });
    if (!!modelIds?.length) OR.push({ modelVersion: { modelId: { in: modelIds } } });
    if (OR.length === 0) {
      res.status(400).json({
        error: 'Must provide at least one of modelIds, modelVersionIds, or modelFileIds',
      });
      return;
    }

    const modelFiles = await dbWrite.modelFile.findMany({
      where: { OR },
      // headerData carries sshs_model_hash; this rebuild deletes every row for the file, so
      // without it a reprocessed file loses its SSHS_12 row the same way it would lose AutoV3.
      select: { rawScanResult: true, id: true, headerData: true },
    });

    for (const { rawScanResult, id: fileId, headerData } of modelFiles) {
      const scanResult = rawScanResult as Prisma.JsonObject;
      if (!scanResult?.hashes) continue;

      // rawScanResult holds the orchestrator's original payload, so AutoV3 is still full-length
      // and SHA256_12 is absent. Same normalization the scan webhook applies — see
      // normalizeScanHashes(); without it a reprocessed file loses its derived hashes.
      const scanned: Partial<Record<ModelHashType, string>> = {};
      for (const [key, hash] of Object.entries(scanResult.hashes)) {
        const type = hashTypeMap[key.toLowerCase()] as ModelHashType | undefined;
        if (type && typeof hash === 'string' && hash) scanned[type] = hash;
      }

      // headerData is passed because rawScanResult never carried sshs_model_hash — the
      // metadata-parse step writes it to its own column — so SSHS_12 is re-derived, not replayed.
      const hashRows = (
        Object.entries(normalizeScanHashes(scanned, headerData)) as Array<[ModelHashType, string]>
      )
        .filter(([, hash]) => Boolean(hash))
        .map(([type, hash]) => ({ fileId, type, hash }));

      await dbWrite.$transaction([
        dbWrite.modelFileHash.deleteMany({ where: { fileId } }),
        dbWrite.modelFileHash.createMany({ data: hashRows }),
      ]);
    }

    res.status(200).json({ files: modelFiles.length });
  },
  ['GET']
);

const hashTypeMap: Record<string, string> = {};
for (const t of Object.keys(ModelHashType)) hashTypeMap[t.toLowerCase()] = t;
