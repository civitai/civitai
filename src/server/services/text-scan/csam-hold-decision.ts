import type { Prisma } from '@prisma/client';
import type { Tracker } from '~/server/clickhouse/client';
import { BanReasonCode } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ModelMeta } from '~/server/schema/model.schema';
import { bulkSetCommentTosViolation } from '~/server/services/comment.service';
import { bulkSetCommentV2TosViolation } from '~/server/services/commentsv2.service';
import { unpublishModelById } from '~/server/services/model.service';
import { deletePost } from '~/server/services/post.service';
import { closeAppealsDeletedByOwner } from '~/server/services/report.service';
import { createStrike } from '~/server/services/strike.service';
import { clearUserProfileFields, toggleBan } from '~/server/services/user.service';
import { throwBadRequestError, throwConflictError } from '~/server/utils/errorHandling';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { EntityType, StrikeReason } from '~/shared/utils/prisma/enums';

/** What a moderator can do with a pending csam hold. `dismiss` is "do nothing". */
export const CSAM_HOLD_DECISIONS = [
  'dismiss',
  'remove',
  'remove_strike',
  'remove_ban',
  'remove_ban_report',
] as const;
export type CsamHoldDecision = (typeof CSAM_HOLD_DECISIONS)[number];

const PLAN: Record<CsamHoldDecision, { remove: boolean; strike: boolean; ban: boolean }> = {
  dismiss: { remove: false, strike: false, ban: false },
  remove: { remove: true, strike: false, ban: false },
  remove_strike: { remove: true, strike: true, ban: false },
  remove_ban: { remove: true, strike: false, ban: true },
  // The NCMEC report is filed by a person in the existing CSAM report form; this only removes and bans.
  remove_ban_report: { remove: true, strike: false, ban: true },
};

/** Types with an existing removal service. A chat message has none yet: its delete lives in a controller. */
const REMOVABLE_ENTITY_TYPES = ['Comment', 'CommentV2', 'UserProfile', 'Post', 'Model'] as const;
const isRemovable = (type: string): type is (typeof REMOVABLE_ENTITY_TYPES)[number] =>
  (REMOVABLE_ENTITY_TYPES as readonly string[]).includes(type);

// Shown to the author in the strike notice.
const STRIKE_DESCRIPTION = 'Content you posted violated our Terms of Service.';
const STRIKE_POINTS = 1;
const MODEL_UNPUBLISH_REASON = 'mature-underage';

/** The moderator-app grants a decision needs beyond `csam.report.file`: the ones the ban and strike actions carry elsewhere. */
export const CSAM_HOLD_DECISION_GRANTS: Partial<
  Record<CsamHoldDecision, 'user.ban' | 'user.strike'>
> = {
  remove_strike: 'user.strike',
  remove_ban: 'user.ban',
  remove_ban_report: 'user.ban',
};

type DecideArgs = {
  holdId: number;
  decision: CsamHoldDecision;
  note?: string;
  actor: { id: number; ip?: string };
  tracker: Tracker;
};

type HeldRow = {
  id: number;
  status: string;
  entityType: string;
  entityId: number;
  userId: number | null;
  text: string;
  meta: Prisma.JsonValue;
};

async function removeContent(hold: HeldRow, { actor, tracker }: DecideArgs) {
  const { entityType, entityId } = hold;
  switch (entityType) {
    case 'Comment':
      await bulkSetCommentTosViolation({ ids: [entityId], actor });
      return;
    case 'CommentV2':
      await bulkSetCommentV2TosViolation({ ids: [entityId], actor });
      return;
    case 'UserProfile':
      await clearUserProfileFields({ userId: entityId });
      return;
    case 'Post': {
      const result = await deletePost({ id: entityId, isModerator: true });
      if (!result) return;
      await closeAppealsDeletedByOwner({
        entityType: EntityType.Image,
        entityIds: result.deletedImageIds,
        ownerId: actor.id,
      });
      await tracker.post({
        type: 'Delete',
        nsfw: !getIsSafeBrowsingLevel(result.nsfwLevel),
        postId: result.id,
        tags: [],
      });
      return;
    }
    case 'Model': {
      const model = await dbWrite.model.findUnique({
        where: { id: entityId },
        select: { meta: true, nsfw: true },
      });
      if (!model) return;
      await unpublishModelById({
        id: entityId,
        reason: MODEL_UNPUBLISH_REASON,
        meta: (model.meta as ModelMeta | null) || {},
        userId: actor.id,
        isModerator: true,
      });
      await tracker.modelEvent({ type: 'Unpublish', modelId: entityId, nsfw: model.nsfw });
      await dataForModelsCache.refresh(entityId);
      return;
    }
  }
}

async function banAuthor(hold: HeldRow, { actor, tracker, holdId }: DecideArgs) {
  const userId = hold.userId as number;
  const author = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true },
  });
  // `toggleBan` flips the state, so an already banned author is left alone rather than unbanned.
  if (author?.bannedAt) return;
  await toggleBan({
    id: userId,
    reasonCode: BanReasonCode.SexualMinor,
    detailsInternal: `csam text hold #${holdId}`,
    userId: actor.id,
    isModerator: true,
  });
  await tracker.userActivity({ type: 'Banned', targetUserId: userId });
}

async function strikeAuthor(hold: HeldRow, { actor, holdId }: DecideArgs) {
  await createStrike({
    userId: hold.userId as number,
    // A moderator's call is never rate limited; the other reasons are limited to one a day.
    reason: StrikeReason.ManualModAction,
    points: STRIKE_POINTS,
    description: STRIKE_DESCRIPTION,
    internalNotes: `csam text hold #${holdId}`,
    // Every csam hold type is an `EntityType`.
    entityType: hold.entityType as EntityType,
    entityId: hold.entityId,
    expiresInDays: 365,
    issuedBy: actor.id,
  });
}

/** Snake case for the subject type: `CommentV2` becomes `comment_v2_text`. */
const subjectTypeOf = (entityType: string) =>
  `${entityType.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_text`;

/**
 * Applies a moderator's decision to a pending csam hold. The content, strike and ban run first and each is
 * safe to repeat, so a failure leaves the hold pending for a retry; the decision and its label-store
 * record are one transaction.
 */
export async function decideCsamHold(args: DecideArgs) {
  const { holdId, decision, note, actor } = args;
  const plan = PLAN[decision];

  const hold = await dbWrite.textScanHold.findFirst({
    where: { id: holdId, label: 'csam' },
    select: {
      id: true,
      status: true,
      entityType: true,
      entityId: true,
      userId: true,
      text: true,
      meta: true,
    },
  });
  if (!hold || hold.status !== 'Pending')
    throw throwConflictError('Hold already decided or missing.');

  if (plan.remove && !isRemovable(hold.entityType))
    throw throwBadRequestError(
      `Removing a ${hold.entityType} is not supported from a hold yet. Dismiss it, or remove it by hand.`
    );
  if ((plan.strike || plan.ban) && !hold.userId)
    throw throwBadRequestError('This hold has no recorded author to strike or ban.');

  if (plan.remove) await removeContent(hold, args);
  if (plan.strike) await strikeAuthor(hold, args);
  if (plan.ban) await banAuthor(hold, args);

  const status = decision === 'dismiss' ? 'Dismissed' : 'Confirmed';
  const decidedAt = new Date();
  await dbWrite.$transaction(async (tx) => {
    const { count } = await tx.textScanHold.updateMany({
      where: { id: holdId, label: 'csam', status: 'Pending' },
      data: {
        status,
        decidedAt,
        decidedById: actor.id,
        decisionNote: note || null,
        meta: {
          ...((hold.meta as Prisma.JsonObject | null) ?? {}),
          decision,
        },
      },
    });
    if (count === 0) throw throwConflictError('Hold already decided or missing.');

    // Records nothing and returns NULL on bad input rather than raising, so a bad record never undoes the
    // decision; it lands in `label_store.record_failure`.
    await tx.$queryRaw`
      SELECT label_store.record_label(
        p_subject_type => ${subjectTypeOf(hold.entityType)},
        p_subject_id => ${String(hold.entityId)},
        p_content_hash => label_store.text_hash(${hold.text}),
        p_family => 'csam_text_hold',
        p_question => 'csam_text.verdict',
        p_value => ${decision === 'dismiss' ? 'not_csam' : 'csam'},
        p_labeller_kind => 'moderator',
        p_source_ref => ${`TextScanHold:${holdId}`},
        p_labelled_at => ${decidedAt}::timestamptz,
        p_labeller_user_id => ${actor.id}::int,
        p_reason => ${decision},
        p_reason_note => ${note || null},
        p_snapshot => ${JSON.stringify({ text: hold.text })}::jsonb,
        p_owner_user_id => ${hold.userId}::int
      )
    `;
  });

  return { status, entityType: hold.entityType, entityId: hold.entityId, userId: hold.userId };
}
