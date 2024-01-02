import { ReportStatus } from '@prisma/client';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';

const baseSetStatusSchema = z.object({
  statusSetById: z.number(),
  status: z.nativeEnum(ReportStatus).default(ReportStatus.Pending),
});

const setReportStatusSchema = baseSetStatusSchema.extend({ reportId: z.number() });
const setManyReportStatusesSchema = baseSetStatusSchema.extend({ reportIds: z.number().array() });

export async function setReportStatus({
  reportId,
  statusSetById,
  status,
}: z.infer<typeof setReportStatusSchema>) {
  await dbWrite.report2.update({
    where: { id: reportId },
    data: { status, statusSetAt: new Date(), statusSetById },
  });
}

export async function setManyReportStatuses({
  reportIds,
  statusSetById,
  status,
}: z.infer<typeof setManyReportStatusesSchema>) {
  await dbWrite.report2.updateMany({
    where: { id: { in: reportIds } },
    data: { status, statusSetAt: new Date(), statusSetById },
  });
}
