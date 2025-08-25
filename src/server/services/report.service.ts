import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import {
  BlockedReason,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';

import { dbRead, dbWrite } from '~/server/db/client';
import { reportAcceptedReward } from '~/server/rewards';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import type {
  CreateEntityAppealInput,
  CreateReportInput,
  GetRecentAppealsInput,
  GetReportsInput,
  ResolveAppealInput,
} from '~/server/schema/report.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import {
  articlesSearchIndex,
  collectionsSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
} from '~/server/search-index';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { queueImageSearchIndexUpdate, updateNsfwLevel } from '~/server/services/image.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import { addTagVotes } from '~/server/services/tag.service';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import {
  AppealStatus,
  BuzzAccountType,
  EntityType,
  ImageEngagementType,
  ImageIngestionStatus,
  ReportReason,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import type { Report } from '~/shared/utils/prisma/models';
import { withRetries } from '~/utils/errorHandling';

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
    data.reason !== ReportReason.NSFW && data.reason !== ReportReason.Automated
      ? await validateReportCreation({
          userId,
          reportType: type,
          entityReportId: id,
          reason: data.reason,
        })
      : null;
  if (validReport) return validReport;

  return await dbWrite.$transaction(async (tx) => {
    // create the report
    const createdReport = await tx.report.create({
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
    if (data.reason === ReportReason.NSFW) {
      switch (type) {
        case ReportEntity.Model:
        case ReportEntity.Image:
          await addTagVotes({
            userId,
            type,
            id,
            tags: data.details.tags ?? [],
            isModerator,
            vote: 1,
          });
          break;
        case ReportEntity.Collection:
          await tx.collection.update({ where: { id }, data: { nsfw: true } });
          await collectionsSearchIndex.queueUpdate([
            { id, action: SearchIndexUpdateQueueAction.Update },
          ]);
          break;
        case ReportEntity.Article:
          await tx.article.update({ where: { id }, data: { nsfw: true } });
          await articlesSearchIndex.queueUpdate([
            { id, action: SearchIndexUpdateQueueAction.Update },
          ]);
          break;
        case ReportEntity.Post:
          await tx.post.update({ where: { id }, data: { nsfw: true } });
          break;
      }
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
        data: {
          ingestion: 'Blocked',
          nsfwLevel: NsfwLevel.Blocked,
          blockedFor: BlockedReason.CSAM,
        },
      });
      await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
      await imagesMetricsSearchIndex.queueUpdate([
        { id, action: SearchIndexUpdateQueueAction.Delete },
      ]);
    }

    return createdReport;
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
          reportAcceptedReward.apply({ userId, reportId: report.id }, { ip })
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

export function getRecentAppealsByUserId({ userId }: GetRecentAppealsInput) {
  return dbRead.appeal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

export function getAppealCount({
  userId,
  status,
  startDate,
}: {
  userId: number;
  status: AppealStatus[];
  startDate?: Date;
}) {
  return dbRead.appeal.count({
    where: { userId, status: { in: status }, createdAt: { gte: startDate } },
  });
}

function getAppealById({ id, select }: GetByIdInput & { select?: Prisma.AppealSelect }) {
  return dbRead.appeal.findUnique({ where: { id }, select });
}

export async function getAppealDetails({ id }: GetByIdInput) {
  const appeal = await getAppealById({ id });
  if (!appeal) throw throwNotFoundError('Appeal not found');

  // Get details based on entityType
  let entityDetails: MixedObject | null = null;
  switch (appeal.entityType) {
    case EntityType.Image:
      entityDetails = await dbRead.image.findUnique({
        where: { id: appeal.entityId },
        select: { id: true, url: true, userId: true },
      });
      break;
    default:
      // Do nothing
      break;
  }

  return { ...appeal, entityDetails };
}

export async function createEntityAppeal({
  entityId,
  entityType,
  message,
  userId,
}: CreateEntityAppealInput & { userId: number }) {
  let buzzTransactionId: string | null = null;
  // check if user has more than 3 pending or rejected appeal in the last 30 days
  const appealsCount = await getAppealCount({
    userId,
    startDate: dayjs().subtract(30, 'days').toDate(),
    status: [AppealStatus.Pending, AppealStatus.Rejected],
  });

  if (appealsCount >= 3) {
    const transaction = await withRetries(() =>
      createBuzzTransaction({
        amount: 100,
        fromAccountId: userId,
        toAccountId: 0,
        type: TransactionType.Appeal,
        fromAccountType: BuzzAccountType.user,
        description: `Appeal fee for ${entityType} ${entityId}`,
      })
    );
    buzzTransactionId = transaction.transactionId;
  }

  try {
    const appeal = await dbWrite.$transaction(async (tx) => {
      switch (entityType) {
        case EntityType.Image:
          // Update entity with needsReview = appeal
          await tx.image.update({
            where: { id: entityId },
            data: { needsReview: 'appeal' },
          });
          break;
        default:
          // Do nothing
          break;
      }

      return tx.appeal.create({
        data: { entityId, entityType, appealMessage: message, userId, buzzTransactionId },
      });
    });

    return appeal;
  } catch (error) {
    await refundTransaction(buzzTransactionId as string, 'Refund appeal fee');
    throw error;
  }
}

export async function resolveEntityAppeal({
  ids,
  entityType,
  status,
  internalNotes,
  resolvedMessage,
  userId,
}: ResolveAppealInput & { userId?: number }) {
  const appeals = await dbRead.appeal.findMany({
    where: { entityId: { in: ids }, status: AppealStatus.Pending, entityType },
    select: {
      id: true,
      entityId: true,
      entityType: true,
      resolvedAt: true,
      buzzTransactionId: true,
      status: true,
      userId: true,
    },
  });
  const affectedIds = appeals.map((a) => a.id);
  if (affectedIds.length === 0) return [];

  await dbWrite.appeal.updateMany({
    where: { id: { in: affectedIds } },
    data: { status, resolvedBy: userId, resolvedMessage, internalNotes, resolvedAt: new Date() },
  });

  const approved = status === AppealStatus.Approved;
  for (const appeal of appeals) {
    switch (appeal.entityType) {
      case EntityType.Image:
        // Update entity with needsReview = null
        await dbWrite.image.update({
          where: { id: appeal.entityId },
          data: approved
            ? {
                needsReview: null,
                blockedFor: null,
                ingestion: ImageIngestionStatus.Scanned,
              }
            : { needsReview: null },
        });

        if (approved) await updateNsfwLevel(appeal.entityId);

        await queueImageSearchIndexUpdate({
          ids: [appeal.entityId],
          action: approved
            ? SearchIndexUpdateQueueAction.Update
            : SearchIndexUpdateQueueAction.Delete,
        });
        break;
      default:
        // Do nothing
        break;
    }

    if (approved && appeal.buzzTransactionId) {
      await withRetries(() =>
        refundTransaction(
          appeal.buzzTransactionId as string,
          `Refunded appeal ${appeal.id} for ${appeal.entityType} ${appeal.entityId}`
        )
      );
    }

    // Notify the user that their appeal has been resolved
    await createNotification({
      userId: appeal.userId,
      type: 'entity-appeal-resolved',
      category: NotificationCategory.Other,
      key: `entity-appeal-resolved:${appeal.entityType}:${appeal.entityId}`,
      details: {
        entityType: appeal.entityType,
        entityId: appeal.entityId,
        status,
        resolvedMessage,
      },
    });
  }

  return appeals;
}
