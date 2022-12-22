import { Prisma, ReportReason, ReportStatus } from '@prisma/client';
import { prisma } from '~/server/db/client';
import { ReportEntity, ReportInput } from '~/server/schema/report.schema';

export const createReport = async ({
  userId,
  type,
  id,
  ...data
}: ReportInput & { userId: number }) => {
  const report: Prisma.ReportCreateNestedOneWithoutModelInput = {
    create: {
      ...data,
      userId,
      status: data.reason === ReportReason.NSFW ? ReportStatus.Valid : ReportStatus.Pending,
    },
  };

  const toUpdate =
    data.reason === ReportReason.NSFW
      ? { nsfw: true }
      : data.reason === ReportReason.TOSViolation
      ? { tosViolation: true }
      : undefined;

  await prisma.$transaction(async (tx) => {
    switch (type) {
      case ReportEntity.Model:
        await tx.modelReport.create({
          data: {
            model: { connect: { id } },
            report,
          },
        });
        if (toUpdate) {
          await tx.model.update({ where: { id }, data: toUpdate });
        }
        break;
      case ReportEntity.Review:
        await prisma.reviewReport.create({
          data: {
            review: { connect: { id } },
            report,
          },
        });
        if (toUpdate) {
          await tx.review.update({ where: { id }, data: toUpdate });
        }
        break;
      case ReportEntity.Comment:
        console.log('_____CREATE COMMENT REPORT____');
        console.log({ id, report });
        await prisma.commentReport.create({
          data: {
            comment: { connect: { id } },
            report,
          },
        });
        if (toUpdate) {
          await tx.comment.update({ where: { id }, data: toUpdate });
        }
        break;
      default:
        throw new Error('unhandled report type');
    }
  });
};
