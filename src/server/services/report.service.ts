import { Prisma, Report, ReportReason, ReportStatus } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateReportInput,
  GetReportCountInput,
  GetReportsInput,
  ReportEntity,
} from '~/server/schema/report.schema';
import { addTagVotes } from '~/server/services/tag.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
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
  reportType: ReportEntity;
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
  isModerator,
  ...data
}: CreateReportInput & { userId: number; isModerator?: boolean }) => {
  let isReportingLocked = false;
  if (type === ReportEntity.Image) {
    const image = await dbRead.imagesOnModels.findFirst({
      where: { imageId: id, modelVersion: { model: { underAttack: true } } },
      select: { imageId: true },
    });
    isReportingLocked = !!image;
  } else if (type === ReportEntity.Model) {
    const model = await dbRead.model.findFirst({
      where: { id, underAttack: true },
      select: { id: true },
    });
    isReportingLocked = !!model;
  }

  if (isReportingLocked) throwBadRequestError('Reporting is locked for this model.');

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

  return dbWrite.$transaction(async (tx) => {
    switch (type) {
      case ReportEntity.Model:
        if (data.reason === ReportReason.NSFW)
          await addTagVotes({
            userId,
            type,
            id,
            tags: data.details.tags ?? [],
            isModerator,
            vote: 1,
          });

        await tx.modelReport.create({
          data: {
            model: { connect: { id } },
            report,
          },
        });
        break;
      case ReportEntity.Comment:
        await tx.commentReport.create({
          data: {
            comment: { connect: { id } },
            report,
          },
        });
        break;
      case ReportEntity.CommentV2:
        await tx.commentV2Report.create({
          data: {
            commentV2: { connect: { id } },
            report,
          },
        });
        break;
      case ReportEntity.Image:
        if (data.reason === ReportReason.NSFW)
          addTagVotes({ userId, type, id, tags: data.details.tags ?? [], isModerator, vote: 1 });

        await tx.imageReport.create({
          data: {
            image: { connect: { id } },
            report,
          },
        });
        break;
      case ReportEntity.ResourceReview:
        await tx.resourceReviewReport.create({
          data: {
            resourceReview: { connect: { id } },
            report,
          },
        });
        break;
      case ReportEntity.Article:
        if (data.reason === ReportReason.NSFW)
          await tx.article.update({ where: { id }, data: { nsfw: true } });

        await tx.articleReport.create({
          data: {
            article: { connect: { id } },
            report,
          },
        });
        break;
      case ReportEntity.Post:
        if (data.reason === ReportReason.NSFW)
          await tx.post.update({ where: { id }, data: { nsfw: true } });

        await tx.postReport.create({
          data: {
            post: { connect: { id } },
            report,
          },
        });
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
  filters,
  sort,
}: GetReportsInput & {
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.ReportWhereInput = {
    [type]: { isNot: null },
  };

  for (const { id, value } of filters ?? []) {
    if (id === 'status') {
      const statuses = value as ReportStatus[];
      if (statuses.length > 0) where.status = { in: statuses };
    } else if (id === 'reason') {
      const reasons = value as ReportReason[];
      if (reasons.length > 0) where.reason = { in: reasons };
    } else if (id === 'reportedBy') where.user = { username: { startsWith: value as string } };
  }

  const items = await dbRead.report.findMany({
    take,
    skip,
    select,
    where,
    orderBy: [{ id: 'desc' }],
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

export const bulkUpdateReports = ({
  ids,
  data,
}: {
  ids: number[];
  data: Prisma.ReportUpdateManyArgs['data'];
}) => {
  return dbWrite.report.updateMany({ where: { id: { in: ids } }, data });
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

export const getResourceReviewReports = <TSelect extends Prisma.ResourceReviewReportSelect>({
  resourceReviewId,
  select,
}: {
  resourceReviewId: number;
  select: TSelect;
}) => {
  return dbRead.resourceReviewReport.findMany({
    select,
    where: { resourceReviewId },
  });
};
