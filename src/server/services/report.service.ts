import { ImageEngagementType, Prisma, Report, ReportReason, ReportStatus } from '@prisma/client';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';

import { dbRead, dbWrite } from '~/server/db/client';
import { reportAcceptedReward } from '~/server/rewards';
import { GetByIdInput } from '~/server/schema/base.schema';
import { CreateReportInput, GetReportsInput, ReportEntity } from '~/server/schema/report.schema';
import {
  articlesSearchIndex,
  collectionsSearchIndex,
  imagesSearchIndex,
} from '~/server/search-index';
import { trackModActivity } from '~/server/services/moderator.service';
import { addTagVotes } from '~/server/services/tag.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
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
  [ReportEntity.Chat]: 'chat',
};

const reportTypeConnectionMap = {
  [ReportEntity.User]: 'userId',
  [ReportEntity.Model]: 'modelId',
  [ReportEntity.Comment]: 'commentId',
  [ReportEntity.CommentV2]: 'commentV2Id',
  [ReportEntity.Image]: 'imageId',
  [ReportEntity.ResourceReview]: 'resourceReviewId',
  [ReportEntity.Article]: 'articleId',
  [ReportEntity.Post]: 'postId',
  [ReportEntity.Collection]: 'collectionId',
  [ReportEntity.Bounty]: 'bountyId',
  [ReportEntity.BountyEntry]: 'bountyEntryId',
  [ReportEntity.Chat]: 'chatId',
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

  // only mods can create csam reports
  if (data.reason === ReportReason.CSAM && !isModerator) throw throwAuthorizationError();

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
          await tx.collection.update({ where: { id }, data: { nsfw: true } });
          return collectionsSearchIndex.queueUpdate([
            { id, action: SearchIndexUpdateQueueAction.Update },
          ]);
        case ReportEntity.Article:
          await tx.article.update({ where: { id }, data: { nsfw: true } });
          return articlesSearchIndex.queueUpdate([
            { id, action: SearchIndexUpdateQueueAction.Update },
          ]);
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
          break;
      }

    if (data.reason === ReportReason.CSAM && type === ReportEntity.Image) {
      await dbWrite.report.updateMany({
        where: {
          reason: { not: ReportReason.CSAM },
          image: { imageId: id },
        },
        data: { status: ReportStatus.Actioned },
      });
      await dbWrite.image.update({
        where: { id },
        data: { ingestion: 'Blocked', nsfwLevel: NsfwLevel.Blocked, blockedFor: 'CSAM' },
      });
      await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
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

export async function bulkSetReportStatus({
  ids,
  status,
  userId,
  ip,
}: {
  ids: number[];
  status: ReportStatus;
  userId: number;
  ip?: string;
}) {
  const statusSetAt = new Date();

  const reports = await dbRead.report.findMany({
    where: { id: { in: ids }, status: { not: status } },
    select: { id: true, userId: true, alsoReportedBy: true },
  });

  if (!reports) return;

  await dbWrite.$transaction(
    reports.map((report) =>
      dbWrite.report.update({
        where: { id: report.id },
        data: {
          status,
          statusSetAt,
          statusSetBy: userId,
          previouslyReviewedCount:
            status === ReportStatus.Actioned ? report.alsoReportedBy.length + 1 : undefined,
        },
      })
    )
  );

  // Track mod activity in the background
  trackModReports({ ids, userId: userId });

  // If we're actioning reports, we need to reward the users who reported them
  if (status === ReportStatus.Actioned) {
    const prepReports = reports.map((report) => ({
      id: report.id,
      userIds: [report.userId, ...report.alsoReportedBy],
    }));

    for (const report of prepReports) {
      await Promise.all(
        report.userIds.map((userId) =>
          reportAcceptedReward.apply({ userId, reportId: report.id }, ip)
        )
      );
    }
  }
}

// #region [helpers]
function trackModReports({ ids, userId }: { ids: number[]; userId: number }) {
  Promise.all(
    ids.map((id) =>
      trackModActivity(userId, {
        entityType: 'report',
        entityId: id,
        activity: 'review',
      })
    )
  );
}
// #endregion
