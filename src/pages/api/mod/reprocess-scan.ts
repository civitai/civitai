import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelHashType, Prisma } from '@prisma/client';

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
      select: { rawScanResult: true, id: true },
    });

    for (const { rawScanResult, id: fileId } of modelFiles) {
      const scanResult = rawScanResult as Prisma.JsonObject;
      if (!scanResult?.hashes) continue;

      await dbWrite.$transaction([
        dbWrite.modelFileHash.deleteMany({ where: { fileId } }),
        dbWrite.modelFileHash.createMany({
          data: Object.entries(scanResult.hashes)
            .filter(([type, hash]) => hashTypeMap[type.toLowerCase()] && hash)
            .map(([type, hash]) => ({
              fileId,
              type: hashTypeMap[type.toLowerCase()] as ModelHashType,
              hash,
            })),
        }),
      ]);
    }

    res.status(200).json({ files: modelFiles.length });
  },
  ['GET']
);

const hashTypeMap: Record<string, string> = {};
for (const t of Object.keys(ModelHashType)) hashTypeMap[t.toLowerCase()] = t;
