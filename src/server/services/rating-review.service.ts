import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { nsfwBrowsingLevelsFlag } from '@civitai/shared';
import {
  buildRatingReviewNotification,
  ratingReviewOwnerLevels,
  textScanResultTextHash,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import { CacheTTL, constants } from '~/server/common/constants';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { bountiesSearchIndex } from '~/server/search-index';
import { tryAutoApproveArticleDispute } from '~/server/services/article-rating-review.helpers';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { enqueueJobs } from '~/server/services/job-queue.service';
import { createNotification } from '~/server/services/notification.service';
import {
  evaluateOverrideAutoApprove,
  getStaleOverrideSignal,
  isModeratorOnlyEntityType,
  isOverrideEntityType,
  type ModeratorOnlyEntityType,
  type OverrideEntityType,
} from '~/server/services/rating-review.derived';
import {
  getRatingReviewScan,
  loadRatingReviewSubject,
  type RatingReviewScan,
  type RatingReviewSubject,
} from '~/server/services/rating-review.entities';
import { ratedEntityDerivedNsfwLevelSql } from '~/server/services/text-scan/scan-floor';
import {
  handleLogError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { EntityType } from '~/shared/utils/prisma/enums';
import { JobQueueType, ReportStatus } from '~/shared/utils/prisma/enums';

const RATING_REVIEW_LIMIT = 3;
const RATING_REVIEW_WINDOW_SECONDS = CacheTTL.day;
const AUTO_APPROVE_MOD_COMMENT = 'Auto-approved: rescan matched requested rating';

export type RatingReviewRow = {
  id: number;
  entityType: string;
  entityId: number;
  userId: number;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  status: ReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  resolvedTextHash: string | null;
};

const PENDING_MESSAGE = 'A dispute is already pending for this item';

export function textChangedSinceResolution(
  last: { resolvedAt: Date | null; resolvedTextHash: string | null } | null,
  updatedAt: Date | null,
  currentHash: string | null
): boolean {
  if (!last) return true;
  if (last.resolvedTextHash != null)
    return currentHash != null && currentHash !== last.resolvedTextHash;
  return !!(last.resolvedAt && updatedAt && updatedAt > last.resolvedAt);
}

async function readReviewState(entityType: RatingReviewEntityType, entityId: number) {
  return Promise.all([
    dbRead.ratingReview.findFirst({
      where: { entityType, entityId, status: ReportStatus.Pending },
      select: { id: true },
    }),
    dbRead.ratingReview.findFirst({
      where: {
        entityType,
        entityId,
        status: { in: [ReportStatus.Actioned, ReportStatus.Unactioned] },
        resolvedAt: { not: null },
      },
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true, resolvedTextHash: true },
    }),
  ]);
}

function assertOwner(ownerId: number | null, userId: number) {
  if (ownerId == null || ownerId !== userId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner can dispute this rating' });
}

type AutoApprovableEntityType = Exclude<OverrideEntityType, ModeratorOnlyEntityType>;

const isAutoApprovable = (t: string): t is AutoApprovableEntityType =>
  isOverrideEntityType(t) && !isModeratorOnlyEntityType(t);

const OVERRIDE_TABLE: Record<AutoApprovableEntityType, Prisma.Sql> = {
  Post: Prisma.raw('"Post"'),
  Bounty: Prisma.raw('"Bounty"'),
  BountyEntry: Prisma.raw('"BountyEntry"'),
};

// Raw SQL rather than `tx.<model>.update` so neither write stamps `updatedAt`, which the legacy
// re-file rule still reads.
async function resolveOverrideReview(args: {
  reviewId: number;
  entityType: AutoApprovableEntityType;
  entityId: number;
  ownerUserId: number;
  subject: RatingReviewSubject;
  previousLevel: number;
  suggestedLevel: number;
  derivedLevel: number;
  entryPoint: 'submission' | 'scan-completion';
}): Promise<RatingReviewRow> {
  const { reviewId, entityType, entityId } = args;
  const table = OVERRIDE_TABLE[entityType];

  const won = await dbWrite.$transaction(async (tx) => {
    const scanRow = await tx.entityModeration.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
      select: { result: true },
    });
    const claim = await tx.ratingReview.updateMany({
      where: { id: reviewId, status: ReportStatus.Pending },
      data: {
        status: ReportStatus.Actioned,
        appliedLevel: args.suggestedLevel,
        resolvedAt: new Date(),
        resolvedBy: constants.system.user.id,
        modComment: AUTO_APPROVE_MOD_COMMENT,
        resolvedTextHash: textScanResultTextHash(scanRow?.result),
      },
    });
    if (claim.count !== 1) return false;

    const bountyNsfw =
      entityType === 'Bounty'
        ? Prisma.sql`, "nsfw" = ${(args.suggestedLevel & nsfwBrowsingLevelsFlag) !== 0},
            "lockedProperties" = ARRAY(
              SELECT DISTINCT unnest(COALESCE("lockedProperties", ARRAY[]::text[]) || ARRAY['nsfw']::text[])
            )`
        : Prisma.empty;
    const cleared = await tx.$executeRaw(
      Prisma.sql`UPDATE ${table} SET "moderatorNsfwLevel" = NULL, "moderatorNsfwLevelBasis" = NULL${bountyNsfw} WHERE "id" = ${entityId}`
    );
    if (cleared !== 1) throw throwNotFoundError(`That ${entityType} no longer exists`);
    await tx.$executeRaw(
      Prisma.sql`UPDATE ${table} e SET "nsfwLevel" = ${ratedEntityDerivedNsfwLevelSql(
        entityType,
        'e'
      )} WHERE e."id" = ${entityId}`
    );
    return true;
  });

  const review = (await dbWrite.ratingReview.findUniqueOrThrow({
    where: { id: reviewId },
  })) as RatingReviewRow;
  if (!won) return review;

  await enqueueJobs([
    { entityId, entityType: entityType as EntityType, type: JobQueueType.UpdateNsfwLevel },
  ]).catch((e) => handleLogError(e, 'rating-review-auto-approve-enqueue', { reviewId }));
  if (entityType === 'Bounty')
    await bountiesSearchIndex
      .queueUpdate([{ id: entityId, action: SearchIndexUpdateQueueAction.Update }])
      .catch((e) => handleLogError(e, 'rating-review-auto-approve-search-index', { reviewId }));
  await createNotification({
    userId: args.ownerUserId,
    category: NotificationCategory.System,
    ...buildRatingReviewNotification({
      reviewId,
      approved: true,
      entityType,
      entityId,
      parentId: args.subject.parentId,
      title: args.subject.title,
      previousLevel: args.previousLevel,
      appliedLevel: args.suggestedLevel,
      modComment: null,
    }),
  }).catch((e) => handleLogError(e, 'rating-review-auto-approved-notification', { reviewId }));
  logToAxiom({
    type: 'info',
    name: 'rating-review-auto-resolved',
    entityType,
    entityId,
    reviewId,
    suggestedLevel: args.suggestedLevel,
    derivedLevel: args.derivedLevel,
    entryPoint: args.entryPoint,
  }).catch();
  return review;
}

async function tryAutoApproveOverrideDispute(args: {
  entityType: AutoApprovableEntityType;
  entityId: number;
  ownerUserId: number;
  subject: RatingReviewSubject;
  scan: RatingReviewScan | null;
  suggestedLevel: number;
  userComment: string | null;
}): Promise<RatingReviewRow | null> {
  const gate = await evaluateOverrideAutoApprove(args);
  if (!gate.eligible) return null;

  let reviewId: number;
  try {
    reviewId = (
      await dbWrite.ratingReview.create({
        data: {
          entityType: args.entityType,
          entityId: args.entityId,
          userId: args.ownerUserId,
          currentLevel: args.subject.currentLevel,
          suggestedLevel: args.suggestedLevel,
          userComment: args.userComment,
          status: ReportStatus.Pending,
        },
        select: { id: true },
      })
    ).id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw throwBadRequestError(PENDING_MESSAGE);
    throw e;
  }

  return resolveOverrideReview({
    reviewId,
    entityType: args.entityType,
    entityId: args.entityId,
    ownerUserId: args.ownerUserId,
    subject: args.subject,
    previousLevel: args.subject.currentLevel,
    suggestedLevel: args.suggestedLevel,
    derivedLevel: gate.derivedLevel,
    entryPoint: 'submission',
  });
}

// Article's counterpart is `maybeAutoResolveDisputeAfterScan`. Never throws.
export async function maybeAutoResolveRatingDisputeAfterScan(
  entityType: OverrideEntityType,
  entityId: number
): Promise<void> {
  if (!isAutoApprovable(entityType)) return;
  try {
    const pending = await dbRead.ratingReview.findFirst({
      where: { entityType, entityId, status: ReportStatus.Pending },
      select: { id: true, suggestedLevel: true, userId: true, currentLevel: true },
    });
    if (!pending) return;
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.RATING_DISPUTE, String(pending.userId)))) return;

    // Primary: this runs right after the scan callback wrote the row, and a lagging replica would
    // still show the scan in flight, so the gate would skip until the next scan.
    const [subject, scan] = await Promise.all([
      loadRatingReviewSubject(entityType, entityId, dbWrite),
      getRatingReviewScan(entityType, entityId, dbWrite),
    ]);
    if (!subject) return;
    const gate = await evaluateOverrideAutoApprove({
      entityType,
      entityId,
      subject,
      scan,
      suggestedLevel: pending.suggestedLevel,
    });
    if (!gate.eligible) return;

    await resolveOverrideReview({
      reviewId: pending.id,
      entityType,
      entityId,
      ownerUserId: pending.userId,
      subject,
      previousLevel: pending.currentLevel,
      suggestedLevel: pending.suggestedLevel,
      derivedLevel: gate.derivedLevel,
      entryPoint: 'scan-completion',
    });
  } catch (e) {
    handleLogError(e as Error, 'rating-review-auto-resolve-after-scan', { entityType, entityId });
  }
}

export async function createRatingReview({
  entityType,
  entityId,
  suggestedLevel,
  userComment,
  userId,
  isModerator,
}: {
  entityType: RatingReviewEntityType;
  entityId: number;
  suggestedLevel: number;
  userComment?: string;
  userId: number;
  isModerator?: boolean;
}): Promise<RatingReviewRow> {
  await throwOnBlockedUserContent(userComment, { isModerator, surface: 'ratingReview' });

  const [subject, scan, [existingPending, lastResolved]] = await Promise.all([
    loadRatingReviewSubject(entityType, entityId),
    getRatingReviewScan(entityType, entityId),
    readReviewState(entityType, entityId),
  ]);

  if (!subject) throw throwNotFoundError(`No ${entityType} with id ${entityId}`);
  assertOwner(subject.ownerId, userId);

  if (subject.disputeRestriction) throw throwBadRequestError(subject.disputeRestriction);
  if (entityType !== 'Article' && !scan?.raised && !lastResolved)
    throw throwBadRequestError('Only a rating raised by our text scan can be disputed.');
  if (entityType !== 'Article' && !subject.currentLevel)
    throw throwBadRequestError('This has no rating to dispute yet.');
  if (suggestedLevel === subject.currentLevel)
    throw throwBadRequestError(
      'The suggested rating matches the current rating. Choose a different level.'
    );
  if (!ratingReviewOwnerLevels(entityType, subject.currentLevel).includes(suggestedLevel))
    throw throwBadRequestError('Choose one of the offered ratings.');
  if (existingPending) throw throwBadRequestError(PENDING_MESSAGE);
  if (
    lastResolved &&
    !textChangedSinceResolution(lastResolved, subject.updatedAt, scan?.textHash ?? null)
  )
    throw throwBadRequestError(
      'This rating has already been reviewed. Edit it before disputing again.'
    );

  if (!isModerator) {
    const key = `${REDIS_KEYS.RATING_REVIEW.RATE_LIMIT}:${userId}` as const;
    // `incr` isn't surfaced on the typed client.
    const count = await (redis as any).incr(key);
    if (count === 1) await redis.expire(key, RATING_REVIEW_WINDOW_SECONDS);
    if (count > RATING_REVIEW_LIMIT)
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `You can only dispute ${RATING_REVIEW_LIMIT} ratings per day. Please try again later.`,
      });
  }

  const comment = userComment?.trim() ? userComment.trim() : null;

  if (!isModerator) {
    const auto =
      entityType === 'Article'
        ? await tryAutoApproveArticleDispute({
            articleId: entityId,
            ownerUserId: userId,
            suggestedLevel,
            userComment: comment,
          })
        : isAutoApprovable(entityType)
        ? await tryAutoApproveOverrideDispute({
            entityType,
            entityId,
            ownerUserId: userId,
            subject,
            scan,
            suggestedLevel,
            userComment: comment,
          })
        : null;
    if (auto) return auto as RatingReviewRow;
  }

  try {
    return (await dbWrite.ratingReview.create({
      data: {
        entityType,
        entityId,
        userId,
        currentLevel: subject.currentLevel,
        suggestedLevel,
        userComment: comment,
        status: ReportStatus.Pending,
      },
    })) as RatingReviewRow;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw throwBadRequestError(PENDING_MESSAGE);
    throw e;
  }
}

export async function getRatingReviewForOwner({
  entityType,
  entityId,
  userId,
}: {
  entityType: RatingReviewEntityType;
  entityId: number;
  userId: number;
}) {
  const subject = await loadRatingReviewSubject(entityType, entityId);
  if (!subject) throw throwNotFoundError(`No ${entityType} with id ${entityId}`);
  assertOwner(subject.ownerId, userId);

  const [latest, scan] = await Promise.all([
    dbRead.ratingReview.findFirst({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        currentLevel: true,
        suggestedLevel: true,
        appliedLevel: true,
        userComment: true,
        modComment: true,
        resolvedTextHash: true,
      },
    }),
    getRatingReviewScan(entityType, entityId),
  ]);
  const { resolvedTextHash, ...review } = latest ?? { resolvedTextHash: null };

  const canResubmit =
    !latest ||
    (latest.status !== ReportStatus.Pending &&
      textChangedSinceResolution(
        { resolvedAt: latest.resolvedAt, resolvedTextHash },
        subject.updatedAt,
        scan?.textHash ?? null
      ));

  const overridable = entityType === 'Article' || isOverrideEntityType(entityType);
  const staleOverride = !overridable
    ? null
    : latest?.status === ReportStatus.Pending
    ? { derivedLevel: null, derivedRatingDroppedBelowOverride: false }
    : await getStaleOverrideSignal(entityType as OverrideEntityType | 'Article', entityId, subject);

  return {
    review: latest ? (review as Omit<NonNullable<typeof latest>, 'resolvedTextHash'>) : null,
    canResubmit,
    canDispute:
      !subject.disputeRestriction && (entityType === 'Article' || !!scan?.raised || !!latest),
    currentLevel: subject.currentLevel,
    scanReason: scan?.reason ?? null,
    scanLevel: scan?.level ?? null,
    staleOverride,
  };
}
