import { Prisma, ReportReason, ReportStatus } from '@prisma/client';

import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateReportInput,
  GetReportCountInput,
  GetReportsInput,
  ReportEntity,
} from '~/server/schema/report.schema';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export const getReportById = <TSelect extends Prisma.ReportSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return prisma.report.findUnique({ where: { id }, select });
};

export const createReport = async ({
  userId,
  type,
  id,
  ...data
}: CreateReportInput & { userId: number }) => {
  const report: Prisma.ReportCreateNestedOneWithoutModelInput = {
    create: {
      ...data,
      userId,
      status: data.reason === ReportReason.NSFW ? ReportStatus.Actioned : ReportStatus.Pending,
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
        // look if there's already a report for this model with the same reason
        const existingReport = await tx.modelReport.findFirst({
          where: {
            modelId: id,
            report: { reason: data.reason },
          },
          select: {
            report: {
              select: {
                id: true,
                alsoReportedBy: true,
                previouslyReviewedCount: true,
                status: true,
              },
            },
          },
        });

        if (existingReport) {
          // if there is, just update the report
          const { id, alsoReportedBy, previouslyReviewedCount } = existingReport.report;
          // if alsoReportedBy count is larger than previouslyReviewedCount * 2, then set the status to pending and reset the previouslyReviewedCount
          if (previouslyReviewedCount > 0 && alsoReportedBy.length > previouslyReviewedCount * 2) {
            await tx.report.update({
              where: { id },
              data: { status: ReportStatus.Pending, previouslyReviewedCount: 0 },
            });

            break;
          }

          const newAlsoReportedBy = !alsoReportedBy.includes(userId)
            ? [...alsoReportedBy, userId]
            : alsoReportedBy;

          await tx.report.update({
            where: { id },
            data: {
              alsoReportedBy: newAlsoReportedBy,
            },
          });

          break;
        }

        await tx.modelReport.create({
          data: {
            model: { connect: { id } },
            report,
          },
        });

        if (data.reason === ReportReason.NSFW) {
          await tx.image.updateMany({
            where: { imagesOnModels: { modelVersion: { modelId: id } } },
            data: { nsfw: true },
          });
        }

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
        if (data.reason === ReportReason.NSFW) {
          await tx.image.updateMany({
            where: { imagesOnReviews: { reviewId: id } },
            data: { nsfw: true },
          });

          const review = await tx.review.findUnique({
            where: { id },
            select: { model: { select: { poi: true } } },
          });
          if (review?.model?.poi && report.create) {
            report.create.reason = ReportReason.TOSViolation;
            await prisma.reviewReport.create({
              data: {
                review: { connect: { id } },
                report,
              },
            });
          }
        } else if (data.reason === ReportReason.TOSViolation) {
          await tx.review.update({ where: { id }, data: { tosViolation: true } });
        }
        break;
      case ReportEntity.Comment:
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
      case ReportEntity.Image:
        await tx.imageReport.create({
          data: {
            image: { connect: { id } },
            report,
          },
        });
        if (toUpdate) {
          await tx.image.update({ where: { id }, data: toUpdate });
        }
        break;
      default:
        throw new Error('unhandled report type');
    }
  });
};

// TODO - add reports for questions/answers
// get report by category (model, review, comment)
export const getReports = async <TSelect extends Prisma.ReportSelect>({
  page,
  type,
  limit = 20,
  select,
}: GetReportsInput & {
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.ReportWhereInput = {
    [type]: { isNot: null },
  };
  // if (type) where[type] = {};

  const items = await prisma.report.findMany({
    take,
    skip,
    select,
    where,
    orderBy: [{ createdAt: 'desc' }],
  });
  const count = await prisma.report.count({ where });
  return getPagingData({ items, count }, take, page);
};

export const updateReportById = ({
  id,
  data,
}: GetByIdInput & { data: Prisma.ReportUpdateArgs['data'] }) => {
  return prisma.report.update({ where: { id }, data });
};

export const getReportCounts = ({ type }: GetReportCountInput) => {
  return prisma.report.count({
    where: { [type]: { isNot: null }, status: ReportStatus.Pending },
  });
};

export const getReviewReports = <TSelect extends Prisma.ReviewReportSelect>({
  reviewId,
  select,
}: {
  reviewId: number;
  select: TSelect;
}) => {
  return prisma.reviewReport.findMany({
    select,
    where: { reviewId },
  });
};

export const getCommentReports = <TSelect extends Prisma.CommentReportSelect>({
  commentId,
  select,
}: {
  commentId: number;
  select: TSelect;
}) => {
  return prisma.commentReport.findMany({
    select,
    where: { commentId },
  });
};

export const getImageReports = <TSelect extends Prisma.ImageReportSelect>({
  imageId,
  select,
}: {
  imageId: number;
  select: TSelect;
}) => {
  return prisma.imageReport.findMany({
    select,
    where: { imageId },
  });
};
