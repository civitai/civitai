import { ReportEntity, ReportReason, ReportStatus } from '@prisma/client';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';

const createReportBaseSchema = z.object({
  entityType: z.nativeEnum(ReportEntity),
  reason: z.nativeEnum(ReportReason),
  status: z.nativeEnum(ReportStatus).default(ReportStatus.Pending),
  details: z.string().optional(),
  reportedById: z.number(),
});

const createReportSchema = createReportBaseSchema.extend({ entityId: z.number() });
const createManyReportSchema = createReportBaseSchema.extend({ entityIds: z.number().array() });

export async function createReport({
  entityId,
  entityType,
  reason,
  status,
  details,
  reportedById,
}: z.infer<typeof createReportSchema>) {
  await dbWrite.reportItem.create({
    data: {
      report: {
        connectOrCreate: {
          where: { entityId_entityType: { entityId, entityType } },
          create: { entityId, entityType, status },
        },
      },
      reportedById,
      reason,
      details,
    },
  });
}

export async function createManyReports({
  entityIds,
  entityType,
  reason,
  status,
  details,
  reportedById,
}: z.infer<typeof createManyReportSchema>) {
  const createdAt = new Date();

  await dbWrite.report2.createMany({
    skipDuplicates: true,
    data: entityIds.map((entityId) => ({ entityId, entityType, createdAt, status })),
  });

  const reports = await dbWrite.report2.findMany({
    where: { entityId: { in: entityIds }, entityType, createdAt },
    select: { id: true },
  });

  await dbWrite.reportItem.createMany({
    skipDuplicates: true,
    data: reports.map(({ id }) => ({ reportId: id, reportedById, reason, details })),
  });
}
