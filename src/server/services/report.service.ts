import { Prisma, Report, ReportReason, ReportStatus } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
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
  return dbRead.report.findUnique({ where: { id }, select });
};

const validateReportCreation = async ({
  userId,
  reportType,
  entityReportId,
  reason,
}: {
  userId: number;
  reportType: 'model' | 'review' | 'comment' | 'image';
  entityReportId: number;
  reason: ReportReason;
}): Promise<Report | null> => {
  // Look if there's already a report for this type with the same reason
  const existingReport = await dbWrite.report.findFirst({
    where: { reason, [reportType]: { [`${reportType}Id`]: entityReportId } },
    orderBy: { id: 'desc' },
  });
  if (!existingReport) return null;

  const { id, alsoReportedBy, previouslyReviewedCount } = existingReport;
  // if alsoReportedBy includes the userId, then do nothing
  if (alsoReportedBy.includes(userId)) return existingReport;

  // if alsoReportedBy count is greater than previouslyReviewedCount * 2,
  // then set the status to pending and reset the previouslyReviewedCount
  if (previouslyReviewedCount > 0 && alsoReportedBy.length >= previouslyReviewedCount * 2) {
    const updatedReport = await dbWrite.report.update({
      where: { id },
      data: {
        status: ReportStatus.Pending,
        previouslyReviewedCount: 0,
        alsoReportedBy: [...alsoReportedBy, userId],
      },
    });

    return updatedReport;
  }

  const updatedReport = await dbWrite.report.update({
    where: { id },
    data: {
      alsoReportedBy: [...alsoReportedBy, userId],
    },
  });

  return updatedReport;
};

export const createReport = async ({
  userId,
  type,
  id,
  ...data
}: CreateReportInput & { userId: number }) => {
  const validReport =
    data.reason !== ReportReason.NSFW
      ? await validateReportCreation({
          userId,
          reportType: type,
          entityReportId: id,
          reason: data.reason,
        })
      : null;
  if (validReport) return validReport;

  const report: Prisma.ReportCreateNestedOneWithoutModelInput = {
    create: {
      ...data,
      userId,
      status: data.reason === ReportReason.NSFW ? ReportStatus.Actioned : ReportStatus.Pending,
    },
  };

  const toUpdate = data.reason === ReportReason.NSFW ? { nsfw: true } : undefined;

  return dbWrite.$transaction(async (tx) => {
    switch (type) {
      case ReportEntity.Model:
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
        await dbWrite.reviewReport.create({
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
            await dbWrite.reviewReport.create({
              data: {
                review: { connect: { id } },
                report,
              },
            });
          }
        }
        break;
      case ReportEntity.Comment:
        await dbWrite.commentReport.create({
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

  const items = await dbRead.report.findMany({
    take,
    skip,
    select,
    where,
    orderBy: [{ createdAt: 'desc' }],
  });
  const count = await dbRead.report.count({ where });
  return getPagingData({ items, count }, take, page);
};

export const updateReportById = ({
  id,
  data,
}: GetByIdInput & { data: Prisma.ReportUpdateArgs['data'] }) => {
  return dbWrite.report.update({ where: { id }, data });
};

export const getReportCounts = ({ type }: GetReportCountInput) => {
  return dbRead.report.count({
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
  return dbRead.reviewReport.findMany({
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
  return dbRead.commentReport.findMany({
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
  return dbRead.imageReport.findMany({
    select,
    where: { imageId },
  });
};
