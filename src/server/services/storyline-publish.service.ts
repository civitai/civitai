import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { contentRestriction } from '~/server/common/content-restriction';
import { createNotification } from '~/server/services/notification.service';
import {
  checkStorylineContinuationAtPublish,
  continuationPostSelect,
  continuationReadiness,
  createStorylinePlacement,
  isRefusal,
} from '~/server/services/storyline-placement.service';
import {
  assertCanContinueStoryline,
  assertPostCanBeChapter,
  createRootChapter,
  firstChapterFloor,
  isUniqueViolation,
  storylineCeilingSql,
  writeOwnerChapter,
} from '~/server/services/storyline.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import {
  isStorylineCeilingLevel,
  STORYLINE_MINOR_CEILING,
  storylineCeiling,
  storylineLevelAllowed,
} from '~/shared/utils/storyline';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

/**
 * A post drafted from the storyline flow (`StorylinePendingChapter`) becomes a chapter when it is
 * published. The storyline's owner's draft is written as the chapter once the post is live and
 * rated, here or by the readiness pass; anyone else's is submitted as a continuation at publish,
 * which is when the contributor consents to the price.
 */

/** What the publish request brings that the storyline step needs. */
export type StorylinePublishContext = {
  /** The continuation price the contributor was shown. */
  expectedPrice?: number;
  spendType: BuzzSpendType;
  /** Why the requester may not submit a continuation (muted, email not verified), if they may not. */
  submitRefusal?: string;
  /** The request may spend Buzz: a session or a full-scope key, not a narrower token. */
  canSpend: boolean;
};

/** What publishing did with the draft's storyline, for the editor. */
export type StorylinePublishOutcome = { storylineId: number } & (
  | { status: 'chapterWritten'; chapterId: number; ceilingRaisedTo?: number }
  /** The owner's chapter, written once the post is live and rated. */
  | { status: 'waiting'; reason: PendingChapterWait }
  | { status: 'submitted'; placementId: number }
  /** Published as a post of its own; the draft is no longer linked to the storyline. */
  | { status: 'dropped'; reason: string }
);

/** `restricted`: the owner is muted or has to verify their email, which `storyline.addChapter` refuses. */
type PendingChapterWait = 'notReady' | 'cannotSubmit' | 'aboveRating' | 'restricted';

export type PreparedStorylinePublish = { postId: number; storylineId: number; userId: number } & (
  | { kind: 'closed'; reason: string }
  | { kind: 'owner' }
  | { kind: 'contributor'; parentPostId: number; expectedPrice: number; spendType: BuzzSpendType }
);

const refusalReason = (error: unknown) => {
  if (isRefusal(error)) return error.message;
  throw error;
};

const dropPendingChapter = (postId: number) =>
  dbWrite.storylinePendingChapter.deleteMany({ where: { postId } });

/**
 * Before the publish is written. Null when there is nothing for the storyline step to do: no link,
 * or a contributor's draft published by someone else or with a credential that may not spend,
 * whose click is not the contributor's consent to pay. Throws only for a continuation price the
 * contributor was not shown, which refuses the publish with nothing written.
 */
export async function prepareStorylinePublish({
  postId,
  actorId,
  context,
}: {
  postId: number;
  actorId: number;
  context: StorylinePublishContext;
}): Promise<PreparedStorylinePublish | null> {
  const link = await dbWrite.storylinePendingChapter.findUnique({
    where: { postId },
    select: {
      storylineId: true,
      parentChapterId: true,
      userId: true,
      storyline: { select: { userId: true, tosViolation: true } },
      parentChapter: { select: { postId: true } },
    },
  });
  if (!link) return null;
  const base = { postId, storylineId: link.storylineId, userId: link.userId };
  const isOwner = link.userId === link.storyline.userId;
  if (!isOwner && (!context.canSpend || actorId !== link.userId)) return null;

  const closed = (reason: string) => ({ ...base, kind: 'closed' as const, reason });
  if (link.parentChapterId == null)
    return link.storyline.tosViolation
      ? closed('This storyline was taken down')
      : { ...base, kind: 'owner' };

  const parentPostId = link.parentChapter?.postId;
  if (!parentPostId) return closed(STORYLINE_REFUSALS.notAChapter);
  if (isOwner) {
    const reason = await assertCanContinueStoryline({ parentPostId, placerId: link.userId }).then(
      () => undefined,
      refusalReason
    );
    return reason ? closed(reason) : { ...base, kind: 'owner' };
  }

  if (context.submitRefusal) return closed(context.submitRefusal);
  const terms = await checkStorylineContinuationAtPublish({
    placerId: link.userId,
    parentPostId,
    expectedPrice: context.expectedPrice,
  });
  if ('closedReason' in terms) return closed(terms.closedReason);
  return {
    ...base,
    kind: 'contributor',
    parentPostId,
    expectedPrice: terms.price,
    spendType: context.spendType,
  };
}

/**
 * After the publish has committed. Never throws: the post is published whatever happens here, so
 * a failure is reported in the outcome, not as a failed publish.
 */
export async function finishStorylinePublish(
  prepared: PreparedStorylinePublish
): Promise<StorylinePublishOutcome> {
  const { postId, storylineId } = prepared;
  const drop = async (reason: string): Promise<StorylinePublishOutcome> => {
    await dropPendingChapter(postId).catch(logFailure('could not drop the link', postId));
    return { storylineId, status: 'dropped', reason };
  };

  if (prepared.kind === 'closed') return drop(prepared.reason);

  if (prepared.kind === 'owner') {
    try {
      const result = await promotePendingChapter(postId);
      if (result.status === 'written') {
        await tellCeilingRaised(result, postId);
        return {
          storylineId,
          status: 'chapterWritten',
          chapterId: result.chapterId,
          ceilingRaisedTo: result.ceilingRaisedTo,
        };
      }
      if (result.status === 'waiting')
        return { storylineId, status: 'waiting', reason: result.reason };
      const written = await dbWrite.storylineChapter.findUnique({
        where: { postId },
        select: { id: true },
      });
      return written
        ? { storylineId, status: 'chapterWritten', chapterId: written.id }
        : { storylineId, status: 'waiting', reason: 'notReady' };
    } catch (error) {
      if (isRefusal(error)) return drop(error.message);
      // The link stays, so the readiness pass tries again.
      await logFailure('owner chapter not written at publish', postId)(error);
      return { storylineId, status: 'waiting', reason: 'notReady' };
    }
  }

  try {
    const placement = await createStorylinePlacement({
      placerId: prepared.userId,
      parentPostId: prepared.parentPostId,
      postId,
      expectedPrice: prepared.expectedPrice,
      spendType: prepared.spendType,
      fromPendingLink: true,
    });
    return { storylineId, status: 'submitted', placementId: placement.id };
  } catch (error) {
    if (isRefusal(error)) return drop(error.message);
    await logFailure('continuation not submitted at publish', postId)(error);
    return drop(
      'Your post was published, but it could not be sent to the storyline. Submit it from the storyline instead'
    );
  }
}

const logFailure = (message: string, postId: number) => (error: unknown) =>
  logToAxiom({
    name: 'storyline-publish',
    type: 'error',
    message,
    postId,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);

type PendingChapterPromotion =
  | {
      status: 'written';
      storylineId: number;
      storylineTitle: string;
      userId: number;
      chapterId: number;
      ceilingRaisedTo?: number;
    }
  /** The link stays: the post is not live and rated yet, a scan refused it, or it is rated too high. */
  | { status: 'waiting'; reason: PendingChapterWait }
  /** No link: another writer promoted it first. */
  | { status: 'gone' };

/**
 * Writes the storyline owner's drafted post as its chapter, once the post is live (published, not
 * scheduled for later), every image scanned and out of review, and rated: chapter 1 by
 * `createStoryline`'s rules, a continuation by `addOwnerChapter`'s. The link goes in the same
 * transaction, and is locked first, so the publish step and the readiness pass take turns: the
 * one that waits finds it gone. A refusal throws a 400 and writes nothing; the caller drops the
 * link.
 *
 * Chapter 1 rated above the ceiling the owner picked before uploading raises the ceiling to fit
 * it, except past the safe-for-work cap of a minor-flagged title.
 */
export async function promotePendingChapter(postId: number): Promise<PendingChapterPromotion> {
  try {
    return await dbWrite.$transaction(async (tx): Promise<PendingChapterPromotion> => {
      const [link] = await tx.$queryRaw<
        { storylineId: number; parentChapterId: number | null; userId: number }[]
      >`
        SELECT "storylineId", "parentChapterId", "userId"
        FROM "StorylinePendingChapter"
        WHERE "postId" = ${postId}
        FOR UPDATE
      `;
      if (!link) return { status: 'gone' };
      const storyline = await tx.storyline.findUnique({
        where: { id: link.storylineId },
        select: {
          userId: true,
          title: true,
          maxNsfwLevel: true,
          minorByScan: true,
          tosViolation: true,
        },
      });
      // A contributor's draft is submitted for the owner's approval, never written directly.
      if (!storyline || storyline.userId !== link.userId)
        throw new Error(`storyline: post ${postId} is not its storyline owner's draft`);
      // The owner's own standing, whoever publishes: a moderator's click does not lift a mute.
      // Both pass, so the link waits for them.
      const owner = await tx.user.findUnique({
        where: { id: link.userId },
        select: { muted: true, emailVerified: true, meta: true },
      });
      if (!owner || contentRestriction(owner)) return { status: 'waiting', reason: 'restricted' };

      const post = await tx.post.findUnique({
        where: { id: postId },
        select: continuationPostSelect,
      });
      const readiness = post ? continuationReadiness(post) : 'doomed';
      if (!post || readiness === 'doomed') return { status: 'waiting', reason: 'cannotSubmit' };
      if (readiness !== 'ready') return { status: 'waiting', reason: 'notReady' };

      let chapterId: number;
      let ceilingRaisedTo: number | undefined;
      if (link.parentChapterId == null) {
        if (storyline.tosViolation) throw throwBadRequestError('This storyline was taken down');
        let { maxNsfwLevel } = storyline;
        if (
          !storylineLevelAllowed({
            postLevel: post.nsfwLevel,
            maxNsfwLevel: storylineCeiling(storyline),
          })
        ) {
          const needed = firstChapterFloor(post);
          const fits =
            needed !== null &&
            isStorylineCeilingLevel(needed) &&
            storylineLevelAllowed({
              postLevel: post.nsfwLevel,
              maxNsfwLevel: storylineCeiling({ ...storyline, maxNsfwLevel: needed }),
            });
          if (!fits) return { status: 'waiting', reason: 'aboveRating' };
          maxNsfwLevel = ceilingRaisedTo = needed;
          await tx.storyline.update({ where: { id: link.storylineId }, data: { maxNsfwLevel } });
        }
        await assertPostCanBeChapter(tx, {
          postId,
          authorId: link.userId,
          maxNsfwLevel: storylineCeiling({ ...storyline, maxNsfwLevel }),
        });
        ({ id: chapterId } = await createRootChapter(tx, {
          storylineId: link.storylineId,
          postId,
          userId: link.userId,
        }));
      } else {
        const parentChapter = await tx.storylineChapter.findUnique({
          where: { id: link.parentChapterId },
          select: { postId: true },
        });
        if (!parentChapter?.postId) throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);
        // Blocks with the parent's author, which `addOwnerChapter` does not look at.
        const { parent } = await assertCanContinueStoryline(
          { parentPostId: parentChapter.postId, placerId: link.userId },
          tx
        );
        if (
          !storylineLevelAllowed({
            postLevel: post.nsfwLevel,
            maxNsfwLevel: storylineCeiling(parent.storyline),
          })
        )
          return { status: 'waiting', reason: 'aboveRating' };
        ({ chapterId } = await writeOwnerChapter(tx, {
          parentChapterId: link.parentChapterId,
          postId,
          userId: link.userId,
        }));
      }

      await tx.storylinePendingChapter.delete({ where: { postId } });
      return {
        status: 'written',
        storylineId: link.storylineId,
        storylineTitle: storyline.title,
        userId: link.userId,
        chapterId,
        ceilingRaisedTo,
      };
    });
  } catch (error) {
    // The post's chapter row, or the storyline's chapter 1, committed by a writer that got there
    // between this one's checks and its insert.
    if (isUniqueViolation(error)) return { status: 'gone' };
    throw error;
  }
}

/** Never throws: the chapter is already written. */
async function tellCeilingRaised(
  result: Extract<PendingChapterPromotion, { status: 'written' }>,
  postId: number
) {
  if (!result.ceilingRaisedTo) return;
  try {
    await createNotification({
      userId: result.userId,
      type: 'storyline-ceiling-raised',
      category: NotificationCategory.Creator,
      key: `storyline-ceiling-raised:${result.storylineId}`,
      details: {
        storylineId: result.storylineId,
        storylineTitle: result.storylineTitle,
        maxNsfwLevel: result.ceilingRaisedTo,
      },
    });
  } catch (error) {
    await logFailure('ceiling raise not announced', postId)(error);
  }
}

/**
 * The readiness pass for the owner's drafts: writes each one that has gone live since it was
 * published (a scheduled post, an image that finished scanning, a moderator's review), or that
 * went live with no publish of its own (a model's publish taking its posts with it).
 *
 * Selected in SQL so a batch holds only rows that can be written now: a draft still waiting, or
 * rated past any ceiling it can reach, stays linked and out of the batch until that changes.
 */
export async function promoteReadyPendingChapters({ limit = 200 }: { limit?: number } = {}) {
  const candidates = await selectReadyPendingChapters(limit);

  let promoted = 0;
  let dropped = 0;
  for (const { postId } of candidates) {
    try {
      const result = await promotePendingChapter(postId);
      if (result.status !== 'written') continue;
      promoted++;
      await tellCeilingRaised(result, postId);
    } catch (error) {
      // Caught per row, so one failure does not wedge the batch behind it. A refusal (a block with
      // the parent's author, the post taken into another storyline) does not pass by waiting.
      if (isRefusal(error)) {
        const removed = await dropPendingChapter(postId).catch(() => ({ count: 0 }));
        dropped += removed.count;
      }
      await logFailure(
        isRefusal(error) ? 'owner chapter refused; link dropped' : 'owner chapter not written',
        postId
      )(error);
    }
  }

  return { considered: candidates.length, promoted, dropped };
}

/** The owner's drafts `promotePendingChapter` can write now. */
export function selectReadyPendingChapters(limit: number) {
  return dbWrite.$queryRaw<{ postId: number }[]>`
    SELECT pc."postId"
    FROM "StorylinePendingChapter" pc
    JOIN "Storyline" st ON st.id = pc."storylineId"
    JOIN "Post" p ON p.id = pc."postId"
    JOIN "User" u ON u.id = pc."userId"
    LEFT JOIN "StorylineChapter" parent ON parent.id = pc."parentChapterId"
    WHERE pc."userId" = st."userId"
      AND p."userId" = pc."userId"
      -- Held while the owner is restricted (contentRestriction), as storyline.addChapter refuses them.
      AND NOT u.muted
      AND NOT (
        u."emailVerified" IS NULL
        AND COALESCE(u.meta -> 'emailVerificationRequired' = 'true'::jsonb, false)
      )
      AND NOT st."tosViolation"
      AND p."publishedAt" <= now()
      AND NOT p."tosViolation"
      AND p."nsfwLevel" > 0
      AND NOT EXISTS (SELECT 1 FROM "StorylineChapter" c WHERE c."postId" = p.id)
      AND EXISTS (SELECT 1 FROM "Image" i WHERE i."postId" = p.id)
      AND NOT EXISTS (
        SELECT 1 FROM "Image" i WHERE i."postId" = p.id
          AND (i.ingestion <> 'Scanned' OR i."needsReview" IS NOT NULL
            OR i."tosViolation" OR i.minor OR i.poi)
      )
      -- A level's highest flag is at most C exactly when the level is below 2C.
      AND (
        (
          pc."parentChapterId" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "StorylineChapter" r WHERE r."storylineId" = st.id AND r.depth = 0
          )
          AND p."nsfwLevel" < 2 * (CASE WHEN st."minorByScan" THEN ${STORYLINE_MINOR_CEILING}::int
            ELSE ${NsfwLevel.XXX}::int END)
        )
        OR (
          pc."parentChapterId" IS NOT NULL
          AND parent."removedAt" IS NULL
          AND parent."postId" IS NOT NULL
          AND p."nsfwLevel" < 2 * ${storylineCeilingSql}
        )
      )
    ORDER BY pc."postId" ASC
    LIMIT ${limit}
  `;
}
