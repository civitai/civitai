import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import * as z from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { Prisma } from '@prisma/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';

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

    const useOrchestrator = await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_FILE_SCAN_ORCHESTRATOR);

    const modelFiles = await dbRead.modelFile.findMany({
      where: { OR, type: { not: 'Training Data' } },
      select: useOrchestrator
        ? {
            id: true,
            url: true,
            modelVersion: {
              select: {
                id: true,
                baseModel: true,
                model: { select: { id: true, type: true } },
              },
            },
          }
        : { id: true, url: true },
    });

    const failed: number[] = [];
    const tasks = modelFiles.map((file) => async () => {
      if (useOrchestrator) {
        const f = file as (typeof modelFiles)[number] & {
          modelVersion: {
            id: number;
            baseModel: string;
            model: { id: number; type: ModelType };
          } | null;
        };
        // Guard against orphaned files whose modelVersion was soft-deleted.
        // The conditional Prisma select widens the type but doesn't enforce
        // non-null at runtime.
        if (!f.modelVersion) {
          failed.push(f.id);
          return;
        }
        try {
          await createModelFileScanRequest({
            fileId: f.id,
            modelVersionId: f.modelVersion.id,
            modelId: f.modelVersion.model.id,
            modelType: f.modelVersion.model.type,
            baseModel: f.modelVersion.baseModel,
            priority: 'low',
          });
        } catch {
          failed.push(f.id);
        }
        return;
      }
      await requestScannerTasks({ file, tasks: ['Hash', 'ParseMetadata'], lowPriority: true });
    });

    if (wait) {
      await limitConcurrency(tasks, 20);
      res.status(200).json({ files: modelFiles.length, failed: failed.length });
    } else {
      res.status(200).json({ files: modelFiles.length });
      await limitConcurrency(tasks, 20);
    }
  },
  ['GET']
);
