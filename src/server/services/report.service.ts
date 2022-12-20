import { ReportReason, ReportStatus } from '@prisma/client';
import { prisma } from '~/server/db/client';
import { ReportEntity, ReportInput } from '~/server/schema/report.schema';

export const createReport = async ({
  userId,
  type,
  id,
  ...data
}: ReportInput & { userId: number }) => {
  await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        ...data,
        userId,
        status: data.reason === ReportReason.NSFW ? ReportStatus.Valid : ReportStatus.Pending,
      },
      select: { id: true },
    });

    switch (type) {
      case ReportEntity.Model:
        await tx.modelReport.createMany({
          data: [
            {
              modelId: id,
              reportId: report.id,
            },
          ],
        });
      case ReportEntity.Review:
        await tx.reviewReport.createMany({
          data: [
            {
              reviewId: id,
              reportId: report.id,
            },
          ],
        });
      case ReportEntity.Comment:
        await tx.commentReport.createMany({
          data: [
            {
              commentId: id,
              reportId: report.id,
            },
          ],
        });
      default:
        throw new Error('unhandled report type');
    }
  });
};
