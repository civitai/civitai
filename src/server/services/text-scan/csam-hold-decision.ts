import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { Tracker } from '~/server/clickhouse/client';
import { BanReasonCode } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { lockCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { dataForModelsCache } from '~/server/redis/caches';
import type { ArticleMetadata } from '~/server/schema/article.schema';
import { unpublishArticleById } from '~/server/services/article.service';
import { deleteChatMessage } from '~/server/services/chat.service';
import { bulkSetCommentTosViolation } from '~/server/services/comment.service';
import { bulkSetCommentV2TosViolation } from '~/server/services/commentsv2.service';
import {
  CSAM_HOLD_POST_UNPUBLISH_REASON,
  MATURE_UNDERAGE_REASON,
} from '~/server/services/cdn-access.service';
import { unpublishModelById } from '~/server/services/model.service';
import { unpublishPostAsModerator } from '~/server/services/post.service';
import { createStrike } from '~/server/services/strike.service';
import { clearUserProfileFields, toggleBan } from '~/server/services/user.service';
import { throwBadRequestError, throwConflictError } from '~/server/utils/errorHandling';
import type { EntityType } from '~/shared/utils/prisma/enums';
import { ArticleStatus, StrikeReason } from '~/shared/utils/prisma/enums';

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

/**
 * Every csam hold type has a removal that keeps the content: a flag, a field clear, an unpublish or a
 * soft delete.
 */
const REMOVABLE_ENTITY_TYPES = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'UserProfile',
  'Post',
  'Model',
  'Article',
] as const;
const isRemovable = (type: string): type is (typeof REMOVABLE_ENTITY_TYPES)[number] =>
  (REMOVABLE_ENTITY_TYPES as readonly string[]).includes(type);

// Shown to the author in the strike notice.
const STRIKE_DESCRIPTION = 'Content you posted violated our Terms of Service.';
const STRIKE_POINTS = 1;
const POST_UNPUBLISH_REASON = CSAM_HOLD_POST_UNPUBLISH_REASON;
const MODEL_UNPUBLISH_REASON = MATURE_UNDERAGE_REASON;
const ARTICLE_UNPUBLISH_REASON = 'csam-text-hold';

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
  /** The text hash the moderator reviewed; a rescan may have replaced the held text since. */
  textHash: string;
  decision: CsamHoldDecision;
  note?: string;
  actor: { id: number; ip?: string };
  tracker: Tracker;
  /** Decided along with another hold of the author, without the moderator opening this one. */
  batched?: boolean;
};

/** The label-store reason of a batched decision, so training can tell it from a reviewed one. */
export const CSAM_HOLD_BATCH_REASON = 'batch_apply';

export const STALE_HOLD_MESSAGE =
  'This hold changed after you opened it (the author edited the content). Reload to review the new text.';

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
    case 'ChatMessage': {
      // The hold judged the sender's recent window, not one message. A soft delete: rows and content are kept.
      const window = (hold.meta as { messageIds?: unknown } | null)?.messageIds;
      const ids = Array.isArray(window) && window.length ? (window as number[]) : [entityId];
      for (const messageId of new Set([entityId, ...ids]))
        await deleteChatMessage({
          messageId,
          actorId: actor.id,
          isModerator: true,
          audit: (event) => tracker.chatAudit(event),
        });
      return;
    }
    case 'Post':
      // Unpublish, not delete: the post and its images stay, and a republish restores it.
      await unpublishPostAsModerator({
        id: entityId,
        userId: actor.id,
        reason: POST_UNPUBLISH_REASON,
      });
      return;
    case 'Model': {
      const model = await dbWrite.model.findUnique({
        where: { id: entityId },
        select: { nsfw: true },
      });
      if (!model) return;
      await unpublishModelById({
        id: entityId,
        reason: MODEL_UNPUBLISH_REASON,
        userId: actor.id,
        isModerator: true,
      });
      await tracker.modelEvent({ type: 'Unpublish', modelId: entityId, nsfw: model.nsfw });
      await dataForModelsCache.refresh(entityId);
      return;
    }
    case 'Article': {
      // The advisory lock is the one an ingestion recompute holds, so this status check and write
      // cannot interleave with its publish. A Published article is never flipped by a recompute.
      const published = await dbWrite.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${entityId})`;
        const article = await tx.article.findUnique({
          where: { id: entityId },
          select: { status: true, metadata: true },
        });
        if (!article || article.status === ArticleStatus.UnpublishedViolation) return null;
        const metadata = (article.metadata as ArticleMetadata | null) || {};
        if (article.status === ArticleStatus.Published) return { metadata };
        // unpublishArticleById refuses anything not Published. The violation status is what stops
        // ingestion, the scheduler or the owner from publishing it later; it is not in search now.
        await tx.article.updateMany({
          where: { id: entityId, status: article.status },
          data: {
            status: ArticleStatus.UnpublishedViolation,
            metadata: {
              ...metadata,
              unpublishedReason: ARTICLE_UNPUBLISH_REASON,
              unpublishedAt: new Date().toISOString(),
              unpublishedBy: actor.id,
            },
          },
        });
        return null;
      });
      if (!published) return;
      const { metadata } = published;
      await unpublishArticleById({
        id: entityId,
        reason: ARTICLE_UNPUBLISH_REASON,
        metadata,
        userId: actor.id,
        isModerator: true,
      });
      await tracker.article({ type: 'Unpublish', articleId: entityId, nsfw: false });
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
 * safe to repeat, so the hold is claimed first, and a failure releases the claim and leaves it pending for a retry; the decision and its label-store
 * record are one transaction.
 */
export async function decideCsamHold(args: DecideArgs) {
  const { holdId, textHash, decision, note, actor, batched } = args;
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
      textHash: true,
      meta: true,
    },
  });
  if (!hold || hold.status !== 'Pending')
    throw throwConflictError('Hold already decided or missing.');
  if (hold.textHash !== textHash) throw throwConflictError(STALE_HOLD_MESSAGE);

  if (plan.remove && !isRemovable(hold.entityType))
    throw throwBadRequestError(
      `Removing a ${hold.entityType} is not supported from a hold yet. Dismiss it, or remove it by hand.`
    );
  if ((plan.strike || plan.ban) && !hold.userId)
    throw throwBadRequestError('This hold has no recorded author to strike or ban.');

  // A claim older than this is a crashed decision; the slowest ban or NCMEC decision seen took under 20 s.
  const claimed = await dbWrite.$queryRaw<{ at: string }[]>`
    UPDATE "TextScanHold"
    SET "meta" = (CASE WHEN jsonb_typeof("meta") = 'object' THEN "meta" ELSE '{}'::jsonb END)
      || jsonb_build_object('decisionClaim', jsonb_build_object('by', ${actor.id}::int, 'at', now()))
    WHERE "id" = ${holdId} AND "label" = 'csam' AND "status" = 'Pending' AND "textHash" = ${textHash}
      AND ("meta"->'decisionClaim' IS NULL
        OR ("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '5 minutes')
    RETURNING "meta"->'decisionClaim'->>'at' AS "at"
  `;
  // The claim also checks the hash, so a rescan landing after the read above fails here as stale.
  if (!claimed.length) throw throwConflictError('Hold already decided, changed or missing.');

  const status: 'Dismissed' | 'Confirmed' = decision === 'dismiss' ? 'Dismissed' : 'Confirmed';
  try {
    if (plan.remove) await removeContent(hold, args);
    if (plan.strike) await strikeAuthor(hold, args);
    if (plan.ban) await banAuthor(hold, args);

    const status = decision === 'dismiss' ? 'Dismissed' : 'Confirmed';
    const decidedAt = new Date();
    await dbWrite.$transaction(async (tx) => {
      // Same lock a new detection takes, so the two never interleave.
      if (hold.entityType !== 'ChatMessage') await lockCsamHold(tx, hold.entityType, hold.entityId);
      const { count } = await tx.textScanHold.updateMany({
        where: { id: holdId, label: 'csam', status: 'Pending', textHash },
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
          p_reason => ${batched ? CSAM_HOLD_BATCH_REASON : decision},
          p_reason_note => ${note || null},
          p_snapshot => ${JSON.stringify({ text: hold.text })}::jsonb,
          p_owner_user_id => ${hold.userId}::int
        )
      `;
    });
  } catch (error) {
    // Only our own claim, so a takeover after expiry is not undone by a late failure here.
    await dbWrite.$executeRaw`UPDATE "TextScanHold" SET "meta" = "meta" - 'decisionClaim'
        WHERE "id" = ${holdId} AND "status" = 'Pending' AND "meta"->'decisionClaim'->>'at' = ${claimed[0].at}`.catch(
      () => null
    );
    throw error;
  }

  return { status, entityType: hold.entityType, entityId: hold.entityId, userId: hold.userId };
}

export const CSAM_HOLD_BATCH_MAX = 50;
/** A strike or ban belongs to the author once, with the hold the moderator is on, never per hold. */
const BATCH_DECISIONS = ['remove', 'dismiss'] as const;

const holdId = z.coerce.number().int().positive().max(2147483647);
const textHash = z.string().min(1).max(200);
const note = z.string().trim().max(500).optional();

export const resolveCsamHoldInput = z
  .object({
    holdId: holdId.optional().describe('The hold to decide. Give this or `holds`, not both.'),
    textHash: textHash
      .optional()
      .describe(
        'Required with `holdId`: the text hash of the hold as the moderator saw it; a hold whose text changed since is refused.'
      ),
    holds: z
      .array(z.object({ holdId, textHash }))
      .min(1)
      .max(CSAM_HOLD_BATCH_MAX)
      .optional()
      .describe(
        'Several holds decided as one call and one rate-limit hit, each against its own text hash. Only `remove` and `dismiss`; at most 50.'
      ),
    decision: z.enum(CSAM_HOLD_DECISIONS),
    note: note.describe('Moderator-only note recorded on the hold.'),
  })
  .superRefine((input, ctx) => {
    if ((input.holdId === undefined) === (input.holds === undefined))
      ctx.addIssue({ code: 'custom', message: 'Give exactly one of `holdId` and `holds`.' });
    if (input.holdId !== undefined && input.textHash === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['textHash'],
        message: '`textHash` is required with `holdId`.',
      });
    if (input.holds && !(BATCH_DECISIONS as readonly string[]).includes(input.decision))
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'A batch can only remove or dismiss.',
      });
    if (input.holds && input.textHash !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['textHash'],
        message: 'Each hold of a batch carries its own `textHash`.',
      });
  });

export type CsamHoldBatchResult =
  | {
      holdId: number;
      ok: true;
      status: 'Dismissed' | 'Confirmed';
      entityType: string;
      entityId: number;
      userId: number | null;
    }
  | { holdId: number; ok: false; stale: boolean; error: string };

/** Decides each hold on its own, one after the other: a hold that is stale or refused never stops the rest. */
export async function decideCsamHoldBatch({
  holds,
  decision,
  note,
  actor,
  tracker,
  decide = decideCsamHold,
}: {
  holds: { holdId: number; textHash: string }[];
  decision: CsamHoldDecision;
  note?: string;
  actor: { id: number; ip?: string };
  tracker: Tracker;
  /** Overridable so the loop can be tested without the removal services behind a decision. */
  decide?: typeof decideCsamHold;
}): Promise<CsamHoldBatchResult[]> {
  const results: CsamHoldBatchResult[] = [];
  for (const hold of new Map(holds.map((h) => [h.holdId, h])).values()) {
    try {
      const decided = await decide({
        holdId: hold.holdId,
        textHash: hold.textHash,
        decision,
        note,
        actor,
        tracker,
        batched: true,
      });
      results.push({ holdId: hold.holdId, ok: true, ...decided });
    } catch (error) {
      // Only our own refusals carry text safe to show.
      const refusal = error instanceof TRPCError ? error : null;
      if (!refusal)
        // Code and name only: a Prisma message can echo the arguments, which here are the held text.
        logToAxiom({
          name: 'text-scan',
          type: 'error',
          message: 'csam hold batch decision failed',
          holdId: hold.holdId,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: (error as { code?: unknown } | null | undefined)?.code,
        }).catch(() => null);
      results.push({
        holdId: hold.holdId,
        ok: false,
        stale: refusal?.message === STALE_HOLD_MESSAGE,
        error: refusal?.message ?? 'Could not apply the decision to this hold.',
      });
    }
  }
  return results;
}
