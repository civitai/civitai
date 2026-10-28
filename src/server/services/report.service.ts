import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { MERGE_PERMISSION_REPORT_REASON } from '@civitai/shared/merge-permission';
import { NO_REPORT_REWARD_KEY, reportersWithoutReward } from '@civitai/shared/report-reward';
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
import { TransactionType, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import type {
  CreateEntityAppealInput,
  CreateReportInput,
  ResolveAppealInput,
} from '~/server/schema/report.schema';
import { withAdditionalReport } from '~/server/services/report-details';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { imagesMetricsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import {
  bulkRemoveBlockedImages,
  queueImageSearchIndexUpdate,
  dropBlockedImageDeleteQueue,
  resetBlockedNsfwLevel,
} from '~/server/services/image.service';
import {
  queueComicsForPanelImage,
  updateArticleNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { refreshProfilePicturesForImagesLazy } from '~/server/services/refresh-profile-pictures-lazy';
import { moderationActionEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { addTagVotes } from '~/server/services/tag.service';
import {
  isPrismaUniqueViolation,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
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
import { isSafeToRetry } from '@civitai/buzz';
import {
  APPEAL_ALREADY_PENDING,
  IMAGE_NOT_APPEALABLE,
  isAppealableImage,
  OrphanedAppealReason,
  type OrphanedAppealOutcome,
} from '~/shared/utils/appeal';
import { clickhouse } from '~/server/clickhouse/client';
import { getModeratedTags } from '~/server/services/system-cache';
import { LOCK_REVIEW_KIND, type LockReviewContext } from '@civitai/shared/lock-review';

export const getReportById = <TSelect extends Prisma.ReportSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return dbRead.report.findUnique({ where: { id }, select });
};

/**
 * The `details.placementId` predicate, for reasons that carry one.
 *
 * Returned as a spreadable fragment rather than branching inside the query, so a
 * reason without a placement produces no predicate at all and the generic dedupe
 * behaves exactly as it did.
 */
const reportedPlacementFilter = ({
  reason,
  details,
}: {
  reason: ReportReason;
  details?: MixedObject;
}) => {
  // No predicate applies to any other reason. This early-out is the honest kind.
  if (reason !== ReportReason.StickerPlacement) return {};

  const placementId = (details as { placementId?: number } | undefined)?.placementId;

  // Refuses rather than degrading. Returning `{}` here would silently fold every
  // sticker report on an image back into the first one — the exact defect this
  // predicate exists to fix, wearing the fix's clothes. The number is guaranteed
  // by `z.coerce.number()` in the report schema, which lives in another file and
  // is connected to this one by nothing: loosen it, add a second reason carrying
  // a placementId, or reach this from outside the router, and a silent fold is
  // what a moderator acts on. A 500 is the better failure.
  if (typeof placementId !== 'number' || !Number.isFinite(placementId))
    throw throwBadRequestError('report: a sticker placement report must name a placement');

  // A note is reported separately from the sticker it hangs off, and the
  // discrimination has to run in BOTH directions. Matching on the placement
  // alone for one of them is not a weaker filter, it is a fold: report the note
  // on placement 5, then report the artwork on placement 5, and the second
  // report is appended to the first as "also reported by" — its reason text
  // discarded, and a moderator shown a complaint about a note while the
  // complaint about the artwork is invisible.
  //
  // The cost is that reports filed before this field existed carry no `target`
  // key, and `equals: 'sticker'` does not match a missing one, so a new sticker
  // report will not dedupe against that history. That is a duplicate in the
  // queue, on a fixed and shrinking set of rows — strictly better than dropping
  // a complaint, which is what the asymmetric version did.
  const target =
    (details as { target?: string } | undefined)?.target === 'comment' ? 'comment' : 'sticker';

  return {
    AND: [
      { details: { path: ['placementId'], equals: placementId } },
      { details: { path: ['target'], equals: target } },
    ],
  };
};

/**
 * Game reports are all filed against one game, and most of Game Frame's reasons share
 * `TOSViolation`. Without the violation in the match, a "Child abuse and exploitation" report folds
 * into an earlier "Hate or harassment" one, and the queue shows the moderator the hate label.
 *
 * A game report is also about a subject: the game itself (`game`) or one player's picture in it
 * (`image:<key>`). Matching on it keeps a report about a picture from folding into one about the
 * game or about another picture, where its picture would be dropped with the rest of its details.
 * Reports filed before subjects existed carry none, so a new game report won't fold into them: a
 * duplicate in the queue, never a lost picture.
 */
const reportedGameFrameFilter = ({
  reportType,
  reason,
  details,
}: {
  reportType: ReportEntity;
  reason: ReportReason;
  details?: MixedObject;
}): Prisma.ReportWhereInput[] => {
  if (reportType !== ReportEntity.GameFrameGame) return [];
  const { subject, violation } = (details ?? {}) as { subject?: unknown; violation?: unknown };
  if (typeof subject !== 'string' || !subject)
    throw throwBadRequestError('report: a game report must name its subject');
  const filters: Prisma.ReportWhereInput[] = [{ details: { path: ['subject'], equals: subject } }];
  if (reason !== ReportReason.TOSViolation) return filters;
  if (typeof violation !== 'string' || !violation)
    throw throwBadRequestError('report: a game TOS report must name its violation');
  return [...filters, { details: { path: ['violation'], equals: violation } }];
};

// A merge-permission report names the reporter's model the merge uses; folded into an earlier report
// on the same merge it would lose that, and the moderator would have no model to look up. Narrowed to
// the source model, so two reports about the same pairing still dedupe.
const reportedMergeSourceFilter = ({
  reportType,
  reason,
  details,
}: {
  reportType: ReportEntity;
  reason: ReportReason;
  details?: MixedObject;
}): Prisma.ReportWhereInput[] => {
  if (reportType !== ReportEntity.Model || reason !== ReportReason.AdminAttention) return [];
  const { reason: detailReason, sourceModelId } = (details ?? {}) as {
    reason?: unknown;
    sourceModelId?: unknown;
  };
  if (detailReason !== MERGE_PERMISSION_REPORT_REASON) return [];
  if (typeof sourceModelId !== 'number')
    throw throwBadRequestError('report: a merge-permission report must name the source model');
  return [
    { details: { path: ['reason'], equals: MERGE_PERMISSION_REPORT_REASON } },
    { details: { path: ['sourceModelId'], equals: sourceModelId } },
  ];
};

/** The existing report a new one on this entity would be folded into, if any. */
export const findReportToFoldInto = ({
  reportType,
  entityReportId,
  reason,
  details,
  pendingOnly,
  tx,
}: {
  reportType: ReportEntity;
  entityReportId: number;
  reason: ReportReason;
  details?: MixedObject;
  /** Fold only into a report still waiting for a moderator. */
  pendingOnly?: boolean;
  tx?: Prisma.TransactionClient;
}) => {
  const db = tx ?? dbWrite;
  const entityIdField = reportType === ReportEntity.User ? 'userId' : `${reportType}Id`;
  // A sticker report names one placement, and an image can carry several.
  // Deduping on (reason, image) alone folds a report about placement 2 into
  // an existing one about placement 1 and drops the new details, so a
  // moderator acting on it removes the wrong person's sticker and keeps
  // their Buzz. Narrowed to the placement so the same one still dedupes and
  // a different one does not. Every other reason is unaffected — the
  // predicate is only added when there is a placement to add it for.
  const placement = reportedPlacementFilter({ reason, details });
  const narrowing = [
    ...(('AND' in placement ? placement.AND : undefined) ?? []),
    ...reportedGameFrameFilter({ reportType, reason, details }),
    ...reportedMergeSourceFilter({ reportType, reason, details }),
  ];
  return db.report.findFirst({
    where: {
      reason,
      [reportType]: { [entityIdField]: entityReportId },
      ...(pendingOnly ? { status: ReportStatus.Pending } : {}),
      ...(narrowing.length ? { AND: narrowing } : {}),
    },
    orderBy: { id: 'desc' },
  });
};

const validateReportCreation = async ({
  userId,
  reportType,
  entityReportId,
  reason,
  details,
  pendingOnly,
  tx,
}: {
  userId: number;
  reportType: ReportEntity;
  entityReportId: number;
  reason: ReportReason;
  details?: MixedObject;
  pendingOnly?: boolean;
  tx?: Prisma.TransactionClient;
}): Promise<Report | null> => {
  const db = tx ?? dbWrite;
  const existingReport = await findReportToFoldInto({
    reportType,
    entityReportId,
    reason,
    details,
    pendingOnly,
    tx,
  });

  if (!existingReport) return null;

  const { id, alsoReportedBy, previouslyReviewedCount } = existingReport;
  // if alsoReportedBy includes the userId, then do nothing
  if (alsoReportedBy.includes(userId)) return existingReport;

  const mergedDetails = withAdditionalReport(existingReport.details, { userId, details });

  // if alsoReportedBy count is greater than previouslyReviewedCount * 2,
  // then set the status to pending and reset the previouslyReviewedCount
  if (previouslyReviewedCount > 0 && alsoReportedBy.length >= previouslyReviewedCount * 2) {
    const updatedReport = await db.report.update({
      where: { id },
      data: {
        status: ReportStatus.Pending,
        previouslyReviewedCount: 0,
        alsoReportedBy: [...alsoReportedBy, userId],
        ...(mergedDetails ? { details: mergedDetails } : {}),
      },
    });

    return updatedReport;
  }

  const updatedReport = await db.report.update({
    where: { id },
    data: {
      alsoReportedBy: [...alsoReportedBy, userId],
      ...(mergedDetails ? { details: mergedDetails } : {}),
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
  [ReportEntity.Challenge]: 'challenge',
  [ReportEntity.Bounty]: 'bounty',
  [ReportEntity.BountyEntry]: 'bountyEntry',
  [ReportEntity.Chat]: 'chat',
  [ReportEntity.ComicProject]: 'comicProject',
  [ReportEntity.Model3D]: 'model3d',
  [ReportEntity.Model3DReview]: 'model3dReview',
  [ReportEntity.Announcement]: 'announcement',
  [ReportEntity.Crucible]: 'crucible',
  [ReportEntity.GameFrameGame]: 'gameFrameGame',
  [ReportEntity.Storyline]: 'storyline',
  [ReportEntity.ServiceOffering]: 'serviceOffering',
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
  [ReportEntity.Challenge]: 'challengeId',
  [ReportEntity.Bounty]: 'bountyId',
  [ReportEntity.BountyEntry]: 'bountyEntryId',
  [ReportEntity.Chat]: 'chatId',
  [ReportEntity.ComicProject]: 'comicProjectId',
  [ReportEntity.Model3D]: 'model3dId',
  [ReportEntity.Model3DReview]: 'model3dReviewId',
  [ReportEntity.Announcement]: 'announcementId',
  [ReportEntity.Crucible]: 'crucibleId',
  [ReportEntity.GameFrameGame]: 'gameFrameGameId',
  [ReportEntity.Storyline]: 'storylineId',
  [ReportEntity.ServiceOffering]: 'serviceOfferingId',
} as const;

const statusOverrides: Partial<Record<ReportReason, ReportStatus>> = {
  [ReportReason.NSFW]: ReportStatus.Actioned,
};

type CreateReportProps = CreateReportInput & {
  userId: number;
  isModerator?: boolean;
  /**
   * The reporter may not vote on tags yet (see `requiresEmailVerification`), so an NSFW report
   * records no tag votes or rating request and waits for a moderator.
   */
  emailVerificationRequired?: boolean;
  /**
   * Fold and create on the caller's transaction instead of opening one. The Game Frame endpoint
   * needs its idempotency receipt committed atomically with the report, or a resend after a crash
   * re-appends the reporter to `alsoReportedBy` and pays them twice.
   */
  tx?: Prisma.TransactionClient;
};
/**
 * A sticker report names the placement it is about, and the placement has to be
 * on the thing being reported.
 *
 * Without this the id is whatever the client sent: a moderator opening the
 * report would act on a placement from some other image, which removes an
 * innocent person's sticker and takes their Buzz with it. The picker only ever
 * offers placements on this image, so anything else is either a stale form or a
 * hand-made request — and a listing that offers the right options is not a
 * mutation that refuses the wrong ones.
 */
async function assertReportedPlacementIsOnEntity({
  type,
  entityId,
  details,
}: {
  type: ReportEntity;
  entityId: number;
  details?: MixedObject;
}) {
  const placementId = (details as MixedObject | undefined)?.placementId;
  if (placementId == null) return;

  if (type !== ReportEntity.Image)
    throw throwBadRequestError(
      'report: a sticker placement can only be reported through its image'
    );

  const placement = await dbRead.placement.findFirst({
    where: { id: Number(placementId), surface: 'sticker', targetType: 'image', targetId: entityId },
    select: { id: true },
  });

  if (!placement)
    throw throwBadRequestError('report: that sticker is not on the image being reported');
}

export const createReport = async ({
  userId,
  id,
  isModerator,
  emailVerificationRequired,
  type,
  tx: callerTx,
  ...data
}: CreateReportProps) => {
  // Add report type to details for notifications
  if (!data.details) data.details = {};
  (data.details as MixedObject).reportType = reportTypeNameMap[type];

  // only mods can create csam reports
  if (data.reason === ReportReason.CSAM && !isModerator) throw throwAuthorizationError();

  // User-only on purpose: reporting your own content is how a creator contests a
  // rating, so this must not widen to other entity types.
  if (type === ReportEntity.User && id === userId)
    throw throwBadRequestError(
      'You cannot report your own profile. To reach a moderator about your own account, use the Support Portal at /support-portal.'
    );

  // Read once, here, because the GUARD below needs it and a guard that runs after the dedupe
  // short-circuit is not a guard — a second report on a sitewide announcement would fold into
  // the first and return success. The snapshot it also feeds is stamped further down; see there.
  const reportedAnnouncement =
    type === ReportEntity.Announcement
      ? await dbRead.announcement.findUnique({
          where: { id },
          select: { title: true, content: true, userId: true, metadata: true },
        })
      : null;

  if (type === ReportEntity.Announcement) {
    if (!reportedAnnouncement) throw throwBadRequestError('That announcement no longer exists.');
    // A null author IS the definition of a sitewide, Civitai-written announcement (see the
    // `Announcement.userId` docstring). Reporting Civitai's own announcement to Civitai's
    // moderators has no destination, and the UI offers no kebab on those rows — this is what
    // makes that a rule rather than an appearance.
    if (reportedAnnouncement.userId === null)
      throw throwBadRequestError(
        'Civitai announcements cannot be reported. To reach a moderator about one, use the Support Portal at /support-portal.'
      );
  }

  // Anyone may report a storyline, flag or not, so an id that is not one is a 404 here rather than
  // a failed connect on the join row below.
  if (
    type === ReportEntity.Storyline &&
    !(await dbRead.storyline.findUnique({ where: { id }, select: { id: true } }))
  )
    throw throwNotFoundError('That storyline no longer exists.');
  if (
    type === ReportEntity.ServiceOffering &&
    !(await dbRead.serviceOffering.findUnique({ where: { id }, select: { id: true } }))
  )
    throw throwNotFoundError('That service no longer exists.');

  await assertReportedPlacementIsOnEntity({ type, entityId: id, details: data.details });

  // An image's or a model's mature-content report casts tag votes, unless its reporter may not vote
  // on tags yet. Without them nothing automated acts on it, so, like a crucible's, game's,
  // storyline's or service's, it goes to a moderator like any other reason: deduped, and left Pending.
  // It joins only a report still waiting for one, never an earlier report that was already actioned.
  const castsNoTagVotes =
    !!emailVerificationRequired &&
    data.reason === ReportReason.NSFW &&
    (type === ReportEntity.Image || type === ReportEntity.Model);
  const awaitsModerator =
    type === ReportEntity.Crucible ||
    type === ReportEntity.GameFrameGame ||
    type === ReportEntity.Storyline ||
    type === ReportEntity.ServiceOffering ||
    castsNoTagVotes;
  // Decides who is paid when the report is actioned, so it is the server's, whatever the client sent.
  // Stamped before the dedupe so a folded-in reporter's `additionalReports` entry carries it too.
  const details = data.details as MixedObject;
  if (castsNoTagVotes) details[NO_REPORT_REWARD_KEY] = true;
  else delete details[NO_REPORT_REWARD_KEY];
  const validReport =
    (data.reason !== ReportReason.NSFW || awaitsModerator) && data.reason !== ReportReason.Automated
      ? await validateReportCreation({
          userId,
          reportType: type,
          entityReportId: id,
          reason: data.reason,
          details,
          pendingOnly: castsNoTagVotes,
          tx: callerTx,
        })
      : null;
  if (validReport) return validReport;

  // 🔴 Stamped HERE, below the dedupe short-circuit, not at the read above: `withAdditionalReport`
  // keeps every key but `reportType`, so a snapshot stamped earlier appends a second copy of the
  // unbounded content to the existing row for a duplicate reporter who wrote nothing.
  //
  // 🔴 From the row, never from `details` — the reporter controls that object, and a snapshot a
  // reporter can author is a snapshot a reporter can forge. The join row cascades on announcement
  // delete, which is instant and self-serve, so without this the fastest way to erase a spam
  // report is to delete the announcement it was about.
  if (reportedAnnouncement) {
    const actions = (reportedAnnouncement.metadata as { actions?: { link?: string }[] } | null)
      ?.actions;
    (data.details as MixedObject).announcement = {
      title: reportedAnnouncement.title,
      content: reportedAnnouncement.content,
      link: actions?.[0]?.link ?? null,
      userId: reportedAnnouncement.userId,
    };
  }

  let recomputeArticleNsfwLevelId: number | null = null;

  const writeReport = async (tx: Prisma.TransactionClient) => {
    // create the report
    const createdReport = await tx.report.create({
      data: {
        ...data,
        userId,
        status: (!awaitsModerator && statusOverrides[data.reason]) || ReportStatus.Pending,
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
          //.creates an ImageRatingRequest if the tags included in the report have a higher nsfwLevel than the current image nsfwLevel
          async function createImageRatingRequest() {
            const tagNames = 'tags' in data.details ? data.details.tags : undefined;
            if (!!tagNames?.length) {
              const image = await dbWrite.image.findFirst({
                where: { id },
                select: { nsfwLevel: true, nsfwLevelLocked: true },
              });
              if (image) {
                const moderated = await getModeratedTags();
                const ratings = moderated
                  .filter((x) => tagNames.includes(x.name))
                  .map((x) => x.nsfwLevel);
                const maxRating = Math.max(...ratings);
                if (maxRating > image.nsfwLevel) {
                  await Promise.all([
                    dbWrite.imageRatingRequest.upsert({
                      where: { imageId_userId: { imageId: id, userId: userId } },
                      create: {
                        nsfwLevel: maxRating,
                        imageId: id,
                        userId: userId,
                        weight: 3,
                      },
                      update: { nsfwLevel: maxRating },
                    }),
                    dbWrite.image.update({ where: { id }, data: { nsfwLevelLocked: false } }),
                  ]);
                }
              }
            }
          }

          if (!castsNoTagVotes) {
            await Promise.all([
              type === ReportEntity.Image && createImageRatingRequest(),
              addTagVotes({
                userId,
                type: type,
                id,
                tags: data.details.tags ?? [],
                isModerator,
                vote: 1,
              }),
            ]);
          }

          break;
        case ReportEntity.Article:
          // Defer the nsfwLevel recompute until after the tx commits so the
          // moderation_floor subquery in updateArticleNsfwLevels can observe
          // the Actioned NSFW report we just created. The recompute queues
          // its own search-index update if the level actually changed.
          recomputeArticleNsfwLevelId = id;
          break;
        case ReportEntity.Post:
          await tx.post.update({ where: { id }, data: { nsfw: true } });
          break;
        case ReportEntity.Model3D:
          // TODO(workstream-Q): wire Model3D tag-vote pipeline once Model3D
          // rating-request infra exists. For now we just flip the nsfw flag
          // mirror of Post.
          await tx.model3D.update({ where: { id }, data: { nsfw: true } });
          break;
      }
    }

    // handle TOS violations
    if (data.reason === ReportReason.TOSViolation)
      switch (type) {
        case ReportEntity.Image:
          // Best-effort hide of the reported image. This isn't a toggle, but the
          // reporter may already have the image hidden → P2002 on the
          // (userId, imageId) PK. The desired end-state (image hidden) already
          // holds, so swallow it instead of 500ing the whole report mutation.
          await dbWrite.imageEngagement
            .create({
              data: {
                imageId: id,
                userId,
                type: ImageEngagementType.Hide,
              },
            })
            .catch((error) => {
              if (!isPrismaUniqueViolation(error)) throw error;
            });
          break;
      }

    if (data.reason === ReportReason.CSAM && type === ReportEntity.Image) {
      // `userId` is a moderator: only moderators can file CSAM. Already-actioned reports are left
      // alone so their `statusSetAt` (which drives reporter notifications) is not moved.
      await dbWrite.report.updateMany({
        where: {
          reason: { not: ReportReason.CSAM },
          status: { not: ReportStatus.Actioned },
          image: { imageId: id },
        },
        data: { status: ReportStatus.Actioned, statusSetAt: new Date(), statusSetBy: userId },
      });
      await dbWrite.image.update({
        where: { id },
        data: {
          ingestion: 'Blocked',
          nsfwLevel: NsfwLevel.Blocked,
          blockedFor: BlockedReason.CSAM,
        },
      });
      // Right after the block, not after the transaction: the block above goes through dbWrite, so
      // it autocommits and stands even if a search-index queue below throws, and a refresh placed
      // after the transaction would then never run. The refresh reads the primary, which already
      // has the Blocked row. Never throws.
      await refreshProfilePicturesForImagesLazy([id]);
      // eslint-disable-next-line local-rules/no-io-in-transaction -- TODO(tx-io): search-index delete (Redis) inside the txn on the rare CSAM-block path. Moving out needs hoisting the CSAM guard post-commit; left for a focused change on this sensitive path.
      await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
      // eslint-disable-next-line local-rules/no-io-in-transaction -- TODO(tx-io): see above (CSAM-block path).
      await imagesMetricsSearchIndex.queueUpdate([
        { id, action: SearchIndexUpdateQueueAction.Delete },
      ]);
    }

    return createdReport;
  };
  const createdReport = callerTx
    ? await writeReport(callerTx)
    : await dbWrite.$transaction(writeReport);

  // Runs after the tx commits so the subquery in updateArticleNsfwLevels
  // picks up the newly-Actioned NSFW report we just inserted.
  if (recomputeArticleNsfwLevelId !== null) {
    await updateArticleNsfwLevels([recomputeArticleNsfwLevelId]);
  }

  return createdReport;
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

/** On a CSAM path, the reported account and an image's owner are not rewarded for its reports. */
export function csamReportRewardExclusions(
  reportedUserId: number | undefined,
  imageReports: { reportId: number; image: { userId: number } }[]
) {
  const owners = new Map(imageReports.map((report) => [report.reportId, report.image.userId]));
  return (reportId: number) =>
    [reportedUserId, owners.get(reportId)].filter((id): id is number => id !== undefined);
}

export async function bulkSetReportStatus({
  ids,
  status,
  userId,
  ip,
  noRewardFor = () => [],
  rewardRemovedReporters = true,
}: {
  ids: number[];
  status: ReportStatus;
  userId: number;
  ip?: string;
  /** Reporters of a report who get no reward for it; the report is still actioned. */
  noRewardFor?: (reportId: number) => readonly number[];
  rewardRemovedReporters?: boolean;
}) {
  if (!ids.length) return;

  // One guarded statement on the primary, as the moderator app's `setReportStatus` writes it: a
  // report another path has already moved to `status` matches nothing, so it is not rewritten and
  // its reporters are not paid a second time. Who is paid comes from the rows this changed.
  const reports = await dbWrite.$queryRaw<
    { id: number; userId: number; alsoReportedBy: number[]; details: Prisma.JsonValue }[]
  >`
    UPDATE "Report"
    SET
      status = ${status}::"ReportStatus",
      "statusSetAt" = ${new Date()},
      "statusSetBy" = ${userId},
      "previouslyReviewedCount" = ${
        status === ReportStatus.Actioned
          ? Prisma.sql`coalesce(array_length("alsoReportedBy", 1), 0) + 1`
          : Prisma.sql`"previouslyReviewedCount"`
      }
    WHERE id = ANY(${ids}::int[]) AND status != ${status}::"ReportStatus"
    RETURNING id, "userId", "alsoReportedBy", details
  `;

  // Track mod activity in the background
  trackModReports({ ids, userId: userId });

  // If we're actioning reports, we need to reward the users who reported them
  if (status === ReportStatus.Actioned) {
    const reporterIds = [...new Set(reports.flatMap((r) => [r.userId, ...r.alsoReportedBy]))];
    // The primary: a ban from moments ago may not have reached a replica.
    const removed = rewardRemovedReporters
      ? []
      : await dbWrite.user.findMany({
          where: {
            id: { in: reporterIds },
            OR: [{ bannedAt: { not: null } }, { deletedAt: { not: null } }],
          },
          select: { id: true },
        });
    const removedIds = new Set(removed.map((user) => user.id));
    const prepReports = reports.map((report) => {
      const excluded = [...noRewardFor(report.id), ...reportersWithoutReward(report)];
      return {
        id: report.id,
        userIds: [report.userId, ...report.alsoReportedBy].filter(
          (id) => !removedIds.has(id) && !excluded.includes(id)
        ),
      };
    });

    await Promise.allSettled(
      prepReports.flatMap((report) =>
        report.userIds.map((userId) =>
          reportAcceptedReward.apply({ userId, reportId: report.id }, { ip })
        )
      )
    );
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

export function getRecentAppealsByUserId({ userId }: { userId: number }) {
  return dbRead.appeal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

export function getLatestAppeal({
  entityType,
  entityId,
  userId,
}: {
  entityType: EntityType;
  entityId: number;
  userId: number;
}) {
  return dbRead.appeal.findFirst({
    // In-app appeals only: a site-form appeal on the same entity is a different request.
    where: { entityType, entityId, userId, category: null },
    orderBy: { id: 'desc' },
    select: { id: true, status: true, resolvedAt: true },
  });
}

export async function reopenAppeal({
  id,
  message,
  context,
}: {
  id: number;
  message: string;
  /** null clears the stored context; omitted leaves it. */
  context?: LockReviewContext | null;
}) {
  try {
    return await dbWrite.appeal.update({
      // Image appeals go through `createEntityAppeal`, whose row lock refuses an image carrying the
      // moderator-only review flag. A reopen has no such check, so it must never reach an image.
      where: { id, entityType: { not: EntityType.Image }, category: null },
      data: {
        status: AppealStatus.Pending,
        appealMessage: message,
        // The moderator queue sorts and displays on createdAt, so leaving the
        // original request's stamp puts a months-old row ahead of fresh ones under
        // a date that describes a request nobody is being asked to review.
        createdAt: new Date(),
        resolvedAt: null,
        resolvedBy: null,
        resolvedMessage: null,
        // This row is returned to the appellant, so the previous ruling's moderator-only fields go.
        resolvedReason: null,
        internalNotes: null,
        ...(context !== undefined && { context: context ?? Prisma.DbNull }),
      },
    });
  } catch (error) {
    // Another of the owner's rows went Pending meanwhile: one may be pending at a time.
    if (isPrismaUniqueViolation(error))
      throw throwBadRequestError('Your request is already under review.');
    throw error;
  }
}

const lockReviewWhere = {
  context: { path: ['kind'], equals: LOCK_REVIEW_KIND },
} satisfies Prisma.AppealWhereInput;

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
    where: {
      userId,
      status: { in: status },
      createdAt: { gte: startDate },
      // Site-form appeals carry no fee and never count toward one.
      category: null,
      // Waiting on review because the content was removed first is not the user's doing.
      NOT: { status: AppealStatus.Pending, entityRemovedAt: { not: null } },
      // A request to unlock a setting is not a dispute of a removal.
      AND: [{ OR: [{ context: { equals: Prisma.AnyNull } }, { NOT: lockReviewWhere }] }],
    },
  });
}

function getAppealById({ id, select }: GetByIdInput & { select?: Prisma.AppealSelect }) {
  return dbRead.appeal.findUnique({ where: { id }, select });
}

export async function getAppealDetails({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) {
  const appeal = await getAppealById({
    id,
    select: {
      id: true,
      userId: true,
      entityType: true,
      entityId: true,
      status: true,
      appealMessage: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      resolvedMessage: true,
      resolvedBy: isModerator,
      internalNotes: isModerator,
    },
  });
  // Not found for someone else's appeal too, so ids can't be probed.
  if (!appeal || (!isModerator && appeal.userId !== userId))
    throw throwNotFoundError('Appeal not found');

  // Get details based on entityType
  let entityDetails: MixedObject | null = null;
  switch (appeal.entityType) {
    case EntityType.Image:
      entityDetails = await dbRead.image.findUnique({
        where: { id: appeal.entityId },
        select: { id: true, url: true, userId: true },
      });
      break;
    case EntityType.Model:
      entityDetails = await dbRead.model.findUnique({
        where: { id: appeal.entityId },
        select: { id: true, name: true, userId: true },
      });
      break;
    case EntityType.Bounty:
      entityDetails = await dbRead.bounty.findUnique({
        where: { id: appeal.entityId },
        select: { id: true, name: true, userId: true },
      });
      break;
    default:
      // Do nothing
      break;
  }

  return { ...appeal, entityDetails };
}

// The failure path refunds by this prefix, so two submits in the same millisecond must not share it.
const getAppealPrefix = (userId: number) =>
  `appeal-${userId}-${new Date().getTime()}-${randomUUID().slice(0, 8)}`;
const isAppealPrefix = (prefix: string) => prefix.startsWith('appeal-');

export async function createEntityAppeal({
  entityId,
  entityType,
  message,
  userId,
  buzzType,
  skipFee,
  context,
}: Omit<CreateEntityAppealInput, 'locks'> & {
  userId: number;
  buzzType: BuzzSpendType;
  skipFee?: boolean;
  context?: LockReviewContext;
}) {
  let buzzTransactionId: string | null = null;

  if (!skipFee) {
    // check if user has more than 3 pending or rejected appeal in the last 30 days
    const appealsCount = await getAppealCount({
      userId,
      startDate: dayjs().subtract(30, 'days').toDate(),
      status: [AppealStatus.Pending, AppealStatus.Rejected],
    });

    if (appealsCount >= 3) {
      const prefix = getAppealPrefix(userId);
      const data = await withRetries(() =>
        createMultiAccountBuzzTransaction({
          amount: 100,
          fromAccountId: userId,
          toAccountId: 0,
          type: TransactionType.Appeal,
          fromAccountTypes: [buzzType],
          description: `Appeal fee for ${entityType} ${entityId}`,
          externalTransactionIdPrefix: prefix,
        })
      );

      if (data.transactionCount === 0) {
        throw new Error('There was an error creating the appeal transaction.');
      }

      buzzTransactionId = prefix;
    }
  }

  try {
    const appeal = await dbWrite.$transaction(async (tx) => {
      switch (entityType) {
        case EntityType.Image: {
          // The handler refuses any flagged image off a replica read. This re-checks only the
          // moderator-only flag, under the row lock, so one set in between is never overwritten.
          const updated = await tx.$executeRaw`
            UPDATE "Image" SET "needsReview" = 'appeal', "updatedAt" = now()
            WHERE id = ${entityId} AND "needsReview" IS DISTINCT FROM 'csam'
          `;
          if (!updated) throw throwBadRequestError(IMAGE_NOT_APPEALABLE);
          break;
        }
        default:
          // Do nothing
          break;
      }

      return tx.appeal.create({
        data: { entityId, entityType, appealMessage: message, userId, buzzTransactionId, context },
      });
    });

    return appeal;
  } catch (error) {
    if (buzzTransactionId) {
      const prefix = buzzTransactionId;
      try {
        // Retries only when the request provably never landed: retrying a timed-out refund can
        // refund twice, and the log below covers the case where it did not land.
        await refundMultiAccountTransaction(
          {
            externalTransactionIdPrefix: prefix,
            description: `Refund appeal fee for ${entityType} ${entityId}`,
          },
          { shouldRetry: isSafeToRetry }
        );
      } catch (refundError) {
        // No appeal row was written, so nothing else records that this user is owed the fee.
        logToAxiom({
          type: 'error',
          name: 'create-entity-appeal',
          message: 'Failed to refund appeal fee',
          userId,
          entityType,
          entityId,
          buzzTransactionId: prefix,
          error: (refundError as Error).message,
        });
      }
    }
    // Lost the race on the one-Pending-appeal-per-entity index to a concurrent submit.
    if (isPrismaUniqueViolation(error)) throw throwBadRequestError(APPEAL_ALREADY_PENDING);
    throw error;
  }
}

// Display label + (when the entity is publicly reachable) a link for an
// appealed item, surfaced in the resolution email. Entity types with no public
// URL fall back to a label-only reference.
export function appealEntityLink(
  entityType: EntityType,
  entityId: number
): { url?: string; label: string } {
  switch (entityType) {
    case EntityType.Image:
      return { url: `${getBaseUrl()}/images/${entityId}`, label: `Image #${entityId}` };
    case EntityType.Model:
      return { url: `${getBaseUrl()}/models/${entityId}`, label: `Model #${entityId}` };
    case EntityType.Bounty:
      return { url: `${getBaseUrl()}/bounties/${entityId}`, label: `Bounty #${entityId}` };
    case EntityType.Storyline:
      return { url: `${getBaseUrl()}/storylines/${entityId}`, label: `Storyline #${entityId}` };
    default:
      return { label: `${entityType} #${entityId}` };
  }
}

type AppealFeeRef = {
  id: number;
  entityType: EntityType;
  entityId: number;
  buzzTransactionId: string;
};

async function refundAppealFee(appeal: AppealFeeRef) {
  if (isAppealPrefix(appeal.buzzTransactionId)) {
    // A timed-out refund may still land, so only a request that never reached Buzz is retried.
    await refundMultiAccountTransaction(
      {
        externalTransactionIdPrefix: appeal.buzzTransactionId,
        description: `Refund appeal fee for ${appeal.entityType} ${appeal.entityId}`,
      },
      { shouldRetry: isSafeToRetry }
    );
  } else {
    await refundTransaction(
      appeal.buzzTransactionId,
      `Refunded appeal ${appeal.id} for ${appeal.entityType} ${appeal.entityId}`
    );
  }
}

type ClaimedOrphan = Omit<AppealFeeRef, 'buzzTransactionId'> & {
  userId: number;
  buzzTransactionId: string | null;
};

/** An owner who deleted their model is not told that its appeals closed. */
const notifiesOwnerDeleted = (appeal: ClaimedOrphan) => appeal.entityType !== EntityType.Model;

type OrphanCandidate = ClaimedOrphan & {
  createdAt: Date;
  userDeleted: boolean;
  // Set only for a soft-deleted model: whether the appellant deleted it. Otherwise ClickHouse decides.
  modelDeletedByAppellant?: boolean | null;
};

/**
 * Appeals whose appellant deleted the entity after filing. `null` when ClickHouse cannot answer,
 * so the caller routes everything for review rather than closing an appeal it cannot classify.
 */
async function getOwnerDeletedAppealIds(candidates: OrphanCandidate[]) {
  if (!candidates.length) return new Set<number>();
  if (!clickhouse) return null;

  const idsOf = (type: EntityType) => [
    ...new Set(candidates.filter((a) => a.entityType === type).map((a) => a.entityId)),
  ];
  const imageIds = idsOf(EntityType.Image);
  const modelIds = idsOf(EntityType.Model);
  type DeleteEvent = { entityId: number | string; userId: number | string; t: number | string };

  try {
    const [imageDeletes, modelDeletes] = await Promise.all([
      imageIds.length
        ? clickhouse.$query<DeleteEvent>`
            SELECT imageId AS entityId, userId, toUnixTimestamp(time) AS t
            FROM images WHERE type = 'Delete' AND imageId IN (${imageIds})
          `
        : [],
      modelIds.length
        ? clickhouse.$query<DeleteEvent>`
            SELECT modelId AS entityId, userId, toUnixTimestamp(time) AS t
            FROM modelEvents WHERE type IN ('Delete', 'PermanentDelete') AND modelId IN (${modelIds})
          `
        : [],
    ]);
    const deletes = [
      ...imageDeletes.map((e) => ({ ...e, entityType: EntityType.Image })),
      ...modelDeletes.map((e) => ({ ...e, entityType: EntityType.Model })),
    ];

    return new Set(
      candidates
        .filter((a) =>
          deletes.some(
            (e) =>
              e.entityType === a.entityType &&
              Number(e.entityId) === a.entityId &&
              Number(e.userId) === a.userId &&
              Number(e.t) >= Math.floor(a.createdAt.getTime() / 1000)
          )
        )
        .map((a) => a.id)
    );
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'void-orphaned-appeals',
      message: 'Owner-delete lookup failed; routing orphans for review',
      error: (e as Error).message,
    });
    return null;
  }
}

// Keep the CSAM legs in step with the moderator app's exclusion lookup; the hold-marker leg is
// this app's alone, since a kept image is only offered for appeal here.
export async function getAppealExcludedIds({
  imageIds,
  userIds,
}: {
  imageIds: number[];
  userIds: number[];
}) {
  const [images, users] = await Promise.all([
    imageIds.length
      ? dbWrite.$queryRaw<{ id: number }[]>`
          SELECT c.id FROM unnest(${imageIds}::int[]) AS c(id)
          WHERE c.id::text IN (
            SELECT CASE jsonb_typeof(e) WHEN 'object' THEN e->>'id' ELSE e#>>'{}' END
            FROM "CsamReport" cr, jsonb_array_elements(cr.images) e
          )
        `
      : [],
    dbWrite.$queryRaw<{ id: number }[]>`
      SELECT c.id FROM unnest(${userIds}::int[]) AS c(id)
      WHERE EXISTS (SELECT 1 FROM "CsamReport" cr WHERE cr."userId" = c.id)
        OR EXISTS (
          SELECT 1 FROM "UserReport" ur JOIN "Report" r ON r.id = ur."reportId"
          WHERE ur."userId" = c.id AND r.reason = 'CSAM'
        )
        OR EXISTS (SELECT 1 FROM "Image" o WHERE o."userId" = c.id AND o."blockedFor" = 'CSAM')
        -- A hold marker's kept image reads as a moderator block, so an appeal would tip them off.
        OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = c.id)
    `,
  ]);
  return { images: new Set(images.map((r) => r.id)), users: new Set(users.map((r) => r.id)) };
}

/** Whether the owner is under a hold marker or the image is one it kept. Unreadable counts as yes. */
export async function isAppealBlockedByHoldMarker({
  imageId,
  userId,
}: {
  imageId: number;
  userId: number;
}) {
  const [row] = await dbWrite.$queryRaw<{ blocked: unknown }[]>`
    SELECT EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ${userId})
      OR EXISTS (SELECT 1 FROM "EvidenceHoldImage" WHERE "imageId" = ${imageId}) AS blocked
  `;
  return row?.blocked !== false;
}

/**
 * The rule `createEntityAppealHandler` refuses an image appeal on, so the owner's page offers one
 * only when it would be accepted. Anyone else's image reads as no.
 */
export async function canAppealOwnImage({ imageId, userId }: { imageId: number; userId: number }) {
  const [image] = await dbWrite.$queryRaw<
    { blockedFor: string | null; needsReview: string | null }[]
  >`
    SELECT "blockedFor", "needsReview" FROM "Image" WHERE id = ${imageId} AND "userId" = ${userId}
  `;
  if (!image || !isAppealableImage(image)) return false;
  return !(await isAppealBlockedByHoldMarker({ imageId, userId }));
}

async function getDefensiveCloseIds(candidates: ClaimedOrphan[]) {
  const imageIds = candidates
    .filter((a) => a.entityType === EntityType.Image)
    .map((a) => a.entityId);
  const userIds = [...new Set(candidates.map((a) => a.userId))];
  if (!userIds.length) return new Set<number>();

  const { images: imageSet, users: userSet } = await getAppealExcludedIds({ imageIds, userIds });
  return new Set(
    candidates
      .filter(
        (a) =>
          userSet.has(a.userId) || (a.entityType === EntityType.Image && imageSet.has(a.entityId))
      )
      .map((a) => a.id)
  );
}

// Re-checks Pending and the stamp so a moderator who resolved the appeal since the pick wins.
function closeOrphans(ids: number[], reason: string | null) {
  if (!ids.length) return Promise.resolve([] as ClaimedOrphan[]);
  return dbWrite.$queryRaw<ClaimedOrphan[]>`
    UPDATE "Appeal"
    SET status = 'Void'::"AppealStatus", "resolvedReason" = ${reason},
      "resolvedAt" = now(), "updatedAt" = now()
    WHERE id = ANY(${ids})
      AND status = 'Pending'::"AppealStatus" AND "entityRemovedAt" IS NULL
    RETURNING id, "userId", "entityType", "entityId", "buzzTransactionId"
  `;
}

function routeOrphansForReview(ids: number[]) {
  if (!ids.length) return Promise.resolve([] as ClaimedOrphan[]);
  return dbWrite.$queryRaw<ClaimedOrphan[]>`
    UPDATE "Appeal"
    SET "entityRemovedAt" = now(), "updatedAt" = now()
    WHERE id = ANY(${ids})
      AND status = 'Pending'::"AppealStatus" AND "entityRemovedAt" IS NULL
    RETURNING id, "userId", "entityType", "entityId", "buzzTransactionId"
  `;
}

async function refundOrphan(appeal: ClaimedOrphan) {
  const { buzzTransactionId } = appeal;
  if (!buzzTransactionId) return { refunded: false, failed: false };
  try {
    await refundAppealFee({ ...appeal, buzzTransactionId });
    return { refunded: true, failed: false };
  } catch (e) {
    // The appeal is already Void and will not be swept again: this is the only record that the
    // user is still owed the fee.
    logToAxiom({
      type: 'error',
      name: 'void-orphaned-appeals',
      message: 'Failed to refund appeal fee',
      appealId: appeal.id,
      userId: appeal.userId,
      buzzTransactionId,
      error: (e as Error).message,
    });
    return { refunded: false, failed: true };
  }
}

export function notifyOrphanedAppeal(
  appeal: Pick<ClaimedOrphan, 'id' | 'userId' | 'entityType' | 'entityId'>,
  outcome: OrphanedAppealOutcome,
  refunded = false
) {
  return createNotification({
    userId: appeal.userId,
    type: 'entity-appeal-content-removed',
    category: NotificationCategory.Other,
    // The worker drops a repeated key, so the outcome is part of it: a closing notice after
    // "under-review" would never arrive.
    key: `entity-appeal-content-removed:${appeal.id}:${outcome}`,
    details: { entityType: appeal.entityType, entityId: appeal.entityId, outcome, refunded },
  });
}

/**
 * Closes the deleter's pending appeals on entities they just deleted, as the sweep does for an
 * owner delete it can see. Best-effort: the delete already happened, so failures are logged, not thrown.
 */
export async function closeAppealsDeletedByOwner({
  entityType,
  entityIds,
  ownerId,
}: {
  entityType: EntityType;
  entityIds: number[];
  ownerId: number;
}) {
  if (!entityIds.length) return;
  const logFailure = (e: unknown, extra: Record<string, unknown>) =>
    logToAxiom({
      type: 'error',
      name: 'close-appeals-deleted-by-owner',
      message: 'Failed to close appeals on deleted content',
      entityType,
      entityIds,
      ownerId,
      ...extra,
      error: (e as Error).message,
    });

  let closed: ClaimedOrphan[];
  try {
    // An appeal the sweep routed between the delete and now is still closed: the owner deleted it.
    closed = await dbWrite.$queryRaw<ClaimedOrphan[]>`
      UPDATE "Appeal"
      SET status = 'Void'::"AppealStatus", "resolvedReason" = ${OrphanedAppealReason.DeletedByOwner},
        "resolvedAt" = now(), "updatedAt" = now()
      WHERE "entityType" = ${entityType}::"EntityType" AND "entityId" = ANY(${entityIds})
        AND "userId" = ${ownerId} AND status = 'Pending'::"AppealStatus"
      RETURNING id, "userId", "entityType", "entityId", "buzzTransactionId"
    `;
  } catch (e) {
    logFailure(e, {});
    return;
  }
  if (!closed.length) return;

  // Claimed and Void now, so never swept again: the refunds must not wait on anything that can fail.
  const refunded = new Map<number, boolean>();
  for (const appeal of closed) refunded.set(appeal.id, (await refundOrphan(appeal)).refunded);

  let quiet: Set<number>;
  try {
    quiet = await getDefensiveCloseIds(closed);
  } catch (e) {
    // Unclassified, so no one is told.
    logFailure(e, { appealIds: closed.map((a) => a.id) });
    return;
  }
  for (const appeal of closed)
    if (!quiet.has(appeal.id) && notifiesOwnerDeleted(appeal))
      await notifyOrphanedAppeal(appeal, 'closed-owner-deleted', refunded.get(appeal.id));
}

/**
 * Closes and refunds a deleted model's pending appeals without a notice: the owner is already told
 * about the removal. A flag dispute, a lock review or an unpublish appeal (site form) has nothing left to
 * rule on once the model is gone. Best-effort: the delete already happened, so failures are logged, not thrown. The sweep
 * stays the safety net.
 */
export async function closeAppealsOnDeletedModel({ modelId }: { modelId: number }) {
  try {
    const pending = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT a.id FROM "Appeal" a
      WHERE a."entityType" = 'Model'::"EntityType" AND a."entityId" = ${modelId}
        AND a.status = 'Pending'::"AppealStatus" AND a."entityRemovedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Model" m WHERE m.id = a."entityId" AND m."deletedAt" IS NULL)
    `;
    const closed = await closeOrphans(
      pending.map((a) => a.id),
      null
    );
    for (const appeal of closed) await refundOrphan(appeal);
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'close-appeals-on-deleted-model',
      message: 'Failed to close appeals on deleted model',
      modelId,
      error: (e as Error).message,
    });
  }
}

/**
 * Sorts appeals whose entity has been deleted; the moderator queue is driven from the entity row,
 * so it never shows them. An owner who deleted their own content gets the appeal closed and
 * refunded, and is told unless it was a model. Any other deleted model closes quietly; a removed image stays Pending,
 * stamped `entityRemovedAt`, for review, and its owner is told. Some appeals are closed
 * defensively without a notice.
 */
export async function voidOrphanedAppeals({ limit = 1000 }: { limit?: number } = {}) {
  const candidates = await dbWrite.$queryRaw<OrphanCandidate[]>`
    SELECT a.id, a."userId", a."entityType", a."entityId", a."buzzTransactionId", a."createdAt",
      (u."deletedAt" IS NOT NULL) AS "userDeleted",
      (SELECT m."deletedBy" = a."userId" FROM "Model" m
        WHERE m.id = a."entityId" AND m."deletedAt" IS NOT NULL
          AND a."entityType" = 'Model') AS "modelDeletedByAppellant"
    FROM "Appeal" a
    JOIN "User" u ON u.id = a."userId"
    WHERE a.status = 'Pending'::"AppealStatus"
      AND a."entityRemovedAt" IS NULL
      AND (
        (a."entityType" = 'Image' AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.id = a."entityId"))
        OR (a."entityType" = 'Model' AND NOT EXISTS (SELECT 1 FROM "Model" m WHERE m.id = a."entityId" AND m."deletedAt" IS NULL))
      )
    LIMIT ${limit}
  `;

  const defensiveIds = await getDefensiveCloseIds(candidates);
  const isQuiet = (a: OrphanCandidate) => a.userDeleted || defensiveIds.has(a.id);
  const quiet = candidates.filter(isQuiet);
  const rest = candidates.filter((a) => !isQuiet(a));
  // A soft-deleted model records its deleter, so only images and hard-deleted models need ClickHouse.
  const clickhouseIds =
    (await getOwnerDeletedAppealIds(rest.filter((a) => a.modelDeletedByAppellant == null))) ??
    new Set<number>();
  const ownerDeletedIds = new Set([
    ...clickhouseIds,
    ...rest.filter((a) => a.modelDeletedByAppellant === true).map((a) => a.id),
  ]);

  // A deleted model leaves nothing to rule on, whether its appeal disputes a flag or a lock. Only
  // images, where the removal itself can be what is appealed, are routed for review.
  const notOwnerDeleted = rest.filter((a) => !ownerDeletedIds.has(a.id));
  const closeQuietIds = [
    ...quiet.map((a) => a.id),
    ...notOwnerDeleted.filter((a) => a.entityType === EntityType.Model).map((a) => a.id),
  ];

  const closedQuietly = await closeOrphans(closeQuietIds, null);
  const closedOwnerDeleted = await closeOrphans(
    rest.filter((a) => ownerDeletedIds.has(a.id)).map((a) => a.id),
    OrphanedAppealReason.DeletedByOwner
  );
  const routed = await routeOrphansForReview(
    notOwnerDeleted.filter((a) => a.entityType !== EntityType.Model).map((a) => a.id)
  );

  let refunded = 0;
  let refundFailed = 0;
  const refund = async (appeal: ClaimedOrphan) => {
    const result = await refundOrphan(appeal);
    if (result.refunded) refunded++;
    if (result.failed) refundFailed++;
    return result.refunded;
  };

  for (const appeal of closedQuietly) await refund(appeal);
  for (const appeal of closedOwnerDeleted) {
    const wasRefunded = await refund(appeal);
    if (notifiesOwnerDeleted(appeal))
      await notifyOrphanedAppeal(appeal, 'closed-owner-deleted', wasRefunded);
  }
  for (const appeal of routed) await notifyOrphanedAppeal(appeal, 'under-review');

  return {
    closedQuietly: closedQuietly.length,
    closedOwnerDeleted: closedOwnerDeleted.length,
    routedForReview: routed.length,
    refunded,
    refundFailed,
  };
}

export async function resolveEntityAppeal({
  ids,
  entityType,
  status,
  internalNotes,
  resolvedMessage,
  resolvedReason,
  refundBuzz,
  userId,
  modelAppealKind,
}: ResolveAppealInput & {
  userId?: number;
  /** 'flag' leaves a model's pending lock review, which is ruled on by its own path, open. */
  modelAppealKind?: 'flag';
}) {
  // One statement claims the appeals: a concurrent resolution that already closed one gets nothing
  // back for it, so only one of them refunds.
  const appeals = await dbWrite.appeal.updateManyAndReturn({
    where: {
      entityId: { in: ids },
      status: AppealStatus.Pending,
      entityType,
      entityRemovedAt: null,
      category: null,
      // A JSON path NOT alone also drops the rows whose context is NULL, which every flag appeal's is.
      ...(modelAppealKind === 'flag' && {
        OR: [{ context: { equals: Prisma.AnyNull } }, { NOT: lockReviewWhere }],
      }),
    },
    data: {
      status,
      resolvedBy: userId,
      resolvedMessage,
      resolvedReason,
      internalNotes,
      resolvedAt: new Date(),
    },
    select: {
      id: true,
      entityId: true,
      entityType: true,
      resolvedAt: true,
      buzzTransactionId: true,
      status: true,
      userId: true,
      createdAt: true,
    },
  });
  if (appeals.length === 0) return [];

  await settleResolvedAppeals(appeals, { status, resolvedMessage, refundBuzz });
  return appeals;
}

export type ResolvedAppeal = {
  id: number;
  entityId: number;
  entityType: EntityType;
  resolvedAt: Date | null;
  buzzTransactionId: string | null;
  status: AppealStatus;
  userId: number;
  createdAt: Date;
};

/** What follows a ruling on appeals already closed: the entity's own change, any refund, and the
 *  owner's notification and email. For a caller that closes the row itself, under its own lock. */
export async function settleResolvedAppeals(
  appeals: ResolvedAppeal[],
  {
    status,
    resolvedMessage,
    refundBuzz,
  }: Pick<ResolveAppealInput, 'status' | 'resolvedMessage' | 'refundBuzz'>
) {
  const approved = status === AppealStatus.Approved;

  // Batch-fetch recipients once to avoid N+1 lookups inside the loop.
  const recipientIds = [...new Set(appeals.map((a) => a.userId))];
  const recipients = await dbRead.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true, email: true, username: true },
  });
  const recipientMap = new Map(recipients.map((u) => [u.id, u]));

  for (const appeal of appeals) {
    switch (appeal.entityType) {
      case EntityType.Image:
        try {
          // No moderator-only review-flag guard, unlike the moderator app's twin: a Pending image
          // appeal cannot sit beside that flag (`createEntityAppeal` refuses, `reportCsamImages`
          // closes it), so there is nothing here for one to protect.
          const updated = await dbWrite.image.update({
            where: { id: appeal.entityId },
            data: approved
              ? { needsReview: null, blockedFor: null, ingestion: ImageIngestionStatus.Scanned }
              : { needsReview: null },
            select: { postId: true, pHash: true },
          });

          if (approved) {
            // Shared restore path: reset+unlock a Blocked-locked row so the recompute isn't a
            // no-op, then recompute. Same helper handleUnblockImages uses. (ClickUp 868kfwdzq)
            await resetBlockedNsfwLevel(appeal.entityId);
            await dropBlockedImageDeleteQueue([appeal.entityId]);
            // An approved appeal means the block was wrong — drop the pHash from the
            // blocked-hash set so re-uploads of the same image aren't auto-blocked (parity
            // with handleUnblockImages).
            if (updated.pHash != null) await bulkRemoveBlockedImages([updated.pHash]);
          }

          await queueImageSearchIndexUpdate({
            ids: [appeal.entityId],
            action: approved
              ? SearchIndexUpdateQueueAction.Update
              : SearchIndexUpdateQueueAction.Delete,
          });

          // Either direction (approve/deny) flips `needsReview`/`ingestion`, both of which
          // the comic search index gates on — re-queue the parent comic project.
          await queueComicsForPanelImage(appeal.entityId);

          if (updated.postId) await bustCachesForPosts(updated.postId);
        } catch (e) {
          // Image may have been deleted — log but continue resolving the appeal
          console.error(`Failed to update image ${appeal.entityId} for appeal ${appeal.id}: ${e}`);
        }
        break;
      default:
        // Do nothing
        break;
    }

    if ((approved || refundBuzz) && appeal.buzzTransactionId) {
      try {
        await refundAppealFee({ ...appeal, buzzTransactionId: appeal.buzzTransactionId });
      } catch (e) {
        // The appeal is already closed, so this is the only record that the fee is still owed.
        logToAxiom({
          type: 'error',
          name: 'resolve-entity-appeal',
          message: 'Failed to refund appeal fee',
          appealId: appeal.id,
          userId: appeal.userId,
          buzzTransactionId: appeal.buzzTransactionId,
          error: (e as Error).message,
        });
      }
    }

    // Notify the user that their appeal has been resolved
    await createNotification({
      userId: appeal.userId,
      type: 'entity-appeal-resolved',
      category: NotificationCategory.Other,
      // Per appeal and per filing: an entity can be appealed again after a re-block (new row), and a
      // reopened appeal reuses its row; the notification service reuses the row for a repeated key.
      key: `entity-appeal-resolved:${appeal.entityType}:${appeal.entityId}:${
        appeal.id
      }:${appeal.createdAt.getTime()}`,
      details: {
        entityType: appeal.entityType,
        entityId: appeal.entityId,
        status,
        resolvedMessage,
      },
    });
  }

  // Email each affected user once, listing every item they appealed in this
  // resolution (linked when the entity has a public URL). Deduped by user, so a
  // user who appealed several items at once gets a single email.
  const appealsByUser = new Map<number, typeof appeals>();
  for (const appeal of appeals) {
    const list = appealsByUser.get(appeal.userId) ?? [];
    list.push(appeal);
    appealsByUser.set(appeal.userId, list);
  }

  for (const [recipientId, userAppeals] of appealsByUser) {
    const recipient = recipientMap.get(recipientId);
    if (!recipient?.email) continue;
    try {
      // Intentionally omit `resolvedMessage` from the email — moderator
      // free-text is shown only in-app (notification above), never emailed,
      // to avoid exposing potentially explicit/targeted prose. The TOS link in
      // the email template provides the policy reference for rejected appeals.
      await moderationActionEmail.send({
        to: recipient.email,
        username: recipient.username ?? 'User',
        kind: approved ? 'appeal-approved' : 'appeal-rejected',
        items: userAppeals.map((a) => appealEntityLink(a.entityType, a.entityId)),
      });
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'appeal-email-failed',
        message: (error as Error).message,
        error,
      });
    }
  }

  return appeals;
}
