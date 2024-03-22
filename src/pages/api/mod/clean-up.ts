import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { Prisma } from '@prisma/client';
import { getS3Client } from '~/utils/s3-utils';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const stringToNumberArraySchema = z
  .string()
  .transform((s) => s.split(',').map(Number))
  .optional();
const stringToBooleanSchema = z.preprocess((val) => val === true || val === 'true', z.boolean());
const importSchema = z.object({
  modelIds: stringToNumberArraySchema,
  modelVersionIds: stringToNumberArraySchema,
  modelFileIds: stringToNumberArraySchema,
  after: z.coerce.date().optional(),
  all: stringToBooleanSchema.optional().default(false),
  wait: stringToBooleanSchema.optional().default(false),
});

export default ModEndpoint(
  async function cleanModel(req: NextApiRequest, res: NextApiResponse) {
    const { modelIds, modelVersionIds, modelFileIds, after, wait, all } = importSchema.parse(
      req.query
    );

    const OR: Prisma.Enumerable<Prisma.ModelFileWhereInput> = [];
    if (!!modelFileIds?.length) OR.push({ id: { in: modelFileIds } });
    if (!!modelVersionIds?.length) OR.push({ modelVersionId: { in: modelVersionIds } });
    if (!!modelIds?.length) OR.push({ modelVersion: { modelId: { in: modelIds } } });
    if (!!after) OR.push({ createdAt: { gte: after } });
    if (OR.length === 0 && !all) {
      res.status(400).json({
        error: 'Must provide at least one of modelIds, modelVersionIds, modelFileIds, or all',
      });
      return;
    }

    const modelFiles = await dbRead.modelFile.findMany({
      where: { OR, type: { not: 'Training Data' } },
      select: { id: true, url: true },
    });

    const s3 = getS3Client();
    const tasks = modelFiles.map((file) => async () => {
      await requestScannerTasks({ file, s3, tasks: ['Hash', 'ParseMetadata'], lowPriority: true });
    });

    if (wait) {
      await limitConcurrency(tasks, 20);
      res.status(200).json({ files: modelFiles.length });
    } else {
      res.status(200).json({ files: modelFiles.length });
      await limitConcurrency(tasks, 20);
    }
  },
  ['GET']
);
