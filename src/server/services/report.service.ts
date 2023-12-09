import { ImageEngagementType, Prisma, Report, ReportReason, ReportStatus } from '@prisma/client';

import { dbWrite, dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateReportInput,
  GetReportCountInput,
  GetReportsInput,
  ReportEntity,
} from '~/server/schema/report.schema';
import { addTagVotes } from '~/server/services/tag.service';
import { refreshHiddenImagesForUser } from '~/server/services/user-cache.service';
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
  const entityIdField = reportType === ReportEntity.User ? 'userId' : `${reportType}Id`;
  const existingReport = await dbWrite.report.findFirst({
    where: { reason, [reportType]: { [entityIdField]: entityReportId } },
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

const reportTypeNameMap: Record<ReportEntity, string> = {
  [ReportEntity.User]: 'user',
  [ReportEntity.Model]: 'model',
  [ReportEntity.Comment]: 'comment',
  [ReportEntity.CommentV2]: 'comment',
  [ReportEntity.Image]: 'image',
  [ReportEntity.ResourceReview]: 'review',
  [ReportEntity.Article]: 'article',
  [ReportEntity.Post]: 'post',
  [ReportEntity.Collection]: 'collection',
  [ReportEntity.Bounty]: 'bounty',
  [ReportEntity.BountyEntry]: 'bountyEntry',
};

const reportTypeConnectionMap = {
  [ReportEntity.User]: 'userId',
  [ReportEntity.Model]: 'modelId',
  [ReportEntity.Comment]: 'commentId',
  [ReportEntity.CommentV2]: 'commentId',
  [ReportEntity.Image]: 'imageId',
  [ReportEntity.ResourceReview]: 'reviewId',
  [ReportEntity.Article]: 'articleId',
  [ReportEntity.Post]: 'postId',
  [ReportEntity.Collection]: 'collectionId',
  [ReportEntity.Bounty]: 'bountyId',
  [ReportEntity.BountyEntry]: 'bountyEntryId',
} as const;

const statusOverrides: Partial<Record<ReportReason, ReportStatus>> = {
  [ReportReason.NSFW]: ReportStatus.Actioned,
};

type CreateReportProps = CreateReportInput & { userId: number; isModerator?: boolean };
export const createReport = async ({
  userId,
  type,
  id,
  isModerator,
  ...data
}: CreateReportProps) => {
  // Add report type to details for notifications
  if (!data.details) data.details = {};
  (data.details as MixedObject).reportType = reportTypeNameMap[type];

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

  await dbWrite.$transaction(async (tx) => {
    // create the report
    await tx.report.create({
      data: {
        ...data,
        userId,
        status: statusOverrides[data.reason] ?? ReportStatus.Pending,
        [type]: {
          create: {
            [reportTypeConnectionMap[type]]: id,
          },
        },
      },
    });

    // handle NSFW
    if (data.reason === ReportReason.NSFW)
      switch (type) {
        case ReportEntity.Model:
        case ReportEntity.Image:
          return await addTagVotes({
            userId,
            type,
            id,
            tags: data.details.tags ?? [],
            isModerator,
            vote: 1,
          });
        case ReportEntity.Collection:
          return await tx.collection.update({ where: { id }, data: { nsfw: true } });
        case ReportEntity.Article:
          return await tx.article.update({ where: { id }, data: { nsfw: true } });
        case ReportEntity.Post:
          return await tx.post.update({ where: { id }, data: { nsfw: true } });
      }

    // handle TOS violations
    if (data.reason === ReportReason.TOSViolation)
      switch (type) {
        case ReportEntity.Image:
          await dbWrite.imageEngagement.create({
            data: {
              imageId: id,
              userId,
              type: ImageEngagementType.Hide,
            },
          });
          refreshHiddenImagesForUser({ userId });
          break;
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

export const getReportByIds = <TSelect extends Prisma.ReportSelect>({
  ids,
  select,
}: {
  ids: number[];
  select: TSelect;
}) => {
  return dbRead.report.findMany({ where: { id: { in: ids } }, select });
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
