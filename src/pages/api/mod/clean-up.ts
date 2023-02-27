import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { Prisma } from '@prisma/client';
import { getS3Client } from '~/utils/s3-utils';
import { requestScannerTasks } from '~/server/jobs/scan-files';

const stringToNumberArraySchema = z
  .string()
  .transform((s) => s.split(',').map(Number))
  .optional();
const stringToBooleanSchema = z.preprocess((val) => val === true || val === 'true', z.boolean());
const importSchema = z.object({
  modelIds: stringToNumberArraySchema,
  modelVersionIds: stringToNumberArraySchema,
  modelFileIds: stringToNumberArraySchema,
  all: stringToBooleanSchema.optional().default(false),
  wait: stringToBooleanSchema.optional().default(false),
});

export default ModEndpoint(
  async function cleanModel(req: NextApiRequest, res: NextApiResponse) {
    const { modelIds, modelVersionIds, modelFileIds, wait, all } = importSchema.parse(req.query);

    const OR: Prisma.Enumerable<Prisma.ModelFileWhereInput> = [];
    if (!!modelFileIds?.length) OR.push({ id: { in: modelFileIds } });
    if (!!modelVersionIds?.length) OR.push({ modelVersionId: { in: modelVersionIds } });
    if (!!modelIds?.length) OR.push({ modelVersion: { modelId: { in: modelIds } } });
    if (OR.length === 0 && !all) {
      res.status(400).json({
        error: 'Must provide at least one of modelIds, modelVersionIds, modelFileIds, or all',
      });
      return;
    }

    const modelFiles = await dbWrite.modelFile.findMany({
      where: { OR },
      select: { modelVersionId: true, type: true, url: true, format: true },
    });

    const s3 = getS3Client();
    const promises = modelFiles.map(async (file) => {
      await requestScannerTasks({ file, s3, tasks: ['Import', 'Hash'], lowPriority: true });
    });

    if (wait) {
      await Promise.all(promises);
      res.status(200).json({ files: modelFiles.length });
    } else {
      res.status(200).json({ files: modelFiles.length });
      await Promise.all(promises);
    }
  },
  ['GET']
);
