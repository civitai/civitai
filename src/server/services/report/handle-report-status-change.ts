import { ReportStatus } from '@prisma/client';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { reportAcceptedReward } from '~/server/rewards';

const handleReportStatusChangeSchema = z.object({
  reportIds: z.number().array(),
  status: z.nativeEnum(ReportStatus),
  ip: z.string().optional(),
});

export async function handleReportStatusChange({
  reportIds,
  status,
  ip,
}: z.infer<typeof handleReportStatusChangeSchema>) {
  if (status === ReportStatus.Actioned) {
    const actioned = await dbRead.reportItem.findMany({
      where: { reportId: { in: reportIds } },
      select: { reportId: true, reportedById: true },
    });
    await Promise.all(
      actioned.map(({ reportId, reportedById }) =>
        reportAcceptedReward.apply({ userId: reportedById, reportId }, ip)
      )
    );
  }
}
