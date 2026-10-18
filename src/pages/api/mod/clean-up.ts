import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead, dbWrite } from '~/server/db/client';
import * as z from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { Prisma } from '@prisma/client';
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { ScanResultCode } from '~/shared/utils/prisma/enums';

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
  // Re-scan files that already have a result. Off by default: re-queueing settled files is how a
  // broad `after` turns into a flood.
  force: stringToBooleanSchema.optional().default(false),
  // Page cursor: the `nextAfterId` from the previous call's response.
  afterId: z.coerce.number().int().optional(),
});

// Every file here goes to the one scanner pool that also serves new uploads, at normal priority
// (low-priority model-file scans never complete), so one call is bounded and slow by design.
const CLEAN_UP_MAX_FILES = 500;
const CLEAN_UP_CONCURRENCY = 5;
const IN_FLIGHT_WINDOW_MS = 24 * 60 * 60 * 1000;

export default ModEndpoint(
  async function cleanModel(req: NextApiRequest, res: NextApiResponse) {
    const { modelIds, modelVersionIds, modelFileIds, after, wait, all, force, afterId } =
      importSchema.parse(req.query);

    // Named files are re-scanned whatever their state: naming them is the ask.
    const branches: Prisma.ModelFileWhereInput[] = [];
    if (!!modelFileIds?.length) branches.push({ id: { in: modelFileIds } });
    if (!!modelVersionIds?.length) branches.push({ modelVersionId: { in: modelVersionIds } });
    if (!!modelIds?.length) branches.push({ modelVersion: { modelId: { in: modelIds } } });

    // Bulk selection (`after`, or `all` alone) takes what scanFilesFallbackJob would: still Pending,
    // not tombstoned, and not submitted in the last day (a successful submit stamps
    // scanRequestedAt, so those are in flight).
    if (!!after || (all && branches.length === 0)) {
      branches.push({
        ...(after && { createdAt: { gte: after } }),
        ...(!force && {
          virusScanResult: ScanResultCode.Pending,
          AND: [
            { OR: [{ exists: null }, { exists: true }] },
            {
              OR: [
                { scanRequestedAt: null },
                { scanRequestedAt: { lt: new Date(Date.now() - IN_FLIGHT_WINDOW_MS) } },
              ],
            },
          ],
        }),
      });
    }
    if (branches.length === 0) {
      res.status(400).json({
        error: 'Must provide at least one of modelIds, modelVersionIds, modelFileIds, or all',
      });
      return;
    }

    // Composed with AND, never spread, so the cursor and the branches can't overwrite each other's
    // keys. `all` alone with force is an empty branch: left out, so nothing rests on how Prisma
    // reads an empty filter.
    const selection = branches.length === 1 ? branches[0] : { OR: branches };
    const conditions: Prisma.ModelFileWhereInput[] = [
      ...(Object.keys(selection).length > 0 ? [selection] : []),
      ...(afterId !== undefined ? [{ id: { gt: afterId } }] : []),
    ];
    const rows = await dbRead.modelFile.findMany({
      where: {
        ...(conditions.length > 0 && { AND: conditions }),
        type: { not: 'Training Data' },
      },
      orderBy: { id: 'asc' },
      take: CLEAN_UP_MAX_FILES + 1,
      select: {
        id: true,
        url: true,
        modelVersion: {
          select: {
            id: true,
            baseModel: true,
            model: { select: { id: true, type: true } },
          },
        },
      },
    });
    const capped = rows.length > CLEAN_UP_MAX_FILES;
    const modelFiles = capped ? rows.slice(0, CLEAN_UP_MAX_FILES) : rows;
    const page = {
      files: modelFiles.length,
      capped,
      nextAfterId: capped ? modelFiles[modelFiles.length - 1].id : null,
    };

    const failed: number[] = [];
    const tasks = modelFiles.map((file) => async () => {
      // Guard against orphaned files whose modelVersion was soft-deleted.
      if (!file.modelVersion) {
        failed.push(file.id);
        return;
      }
      try {
        await createModelFileScanRequest({
          fileId: file.id,
          modelVersionId: file.modelVersion.id,
          modelId: file.modelVersion.model.id,
          modelType: file.modelVersion.model.type as ModelType,
          baseModel: file.modelVersion.baseModel,
          url: file.url,
          priority: 'normal',
        });
      } catch (err) {
        failed.push(file.id);
        // Admin endpoint: tombstone on permanent 'not-found' so the file
        // exits the scan retry loop. Matches scanFilesFallbackJob policy.
        if (err instanceof ModelFileScanSubmissionError && err.code === 'not-found') {
          await dbWrite.modelFile
            .update({ where: { id: file.id }, data: { exists: false } })
            .catch(() => null);
        }
      }
    });

    if (wait) {
      await limitConcurrency(tasks, CLEAN_UP_CONCURRENCY);
      res.status(200).json({ ...page, failed: failed.length });
    } else {
      res.status(200).json(page);
      await limitConcurrency(tasks, CLEAN_UP_CONCURRENCY);
    }
  },
  ['GET']
);
