import { Prisma } from '@prisma/client';
import {
  muteableThreadsCte,
  threadIsRooted,
  UNRESOLVED_THREAD_CHAIN_MESSAGE,
} from '~/server/common/thread-chain';
import { dbWrite } from '~/server/db/client';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import type { ReactionEntityType } from '~/server/schema/reaction.schema';
import { amIBlockedByUser } from '~/server/services/user.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Every entity type any write path can hand the owner resolver: comment surfaces
 * plus reaction surfaces. Adding a member to either enum breaks the switch in
 * `getBlockCheckOwnerIds` until an owner is resolved for it.
 */
export type BlockCheckEntityType = CommentConnectorInput['entityType'] | ReactionEntityType;

// Every lookup here guards a write that lands on the primary. On the replica a row written moments
// ago is not there yet, and a target that resolves no owner is allowed through.
const guardDb = dbWrite;

// Must list EVERY owner-bearing FK on `Thread`. A column missing here resolves no
// root owner for replies in that kind of thread, silently skipping the block.
export const threadContentSelect = {
  imageId: true,
  postId: true,
  articleId: true,
  modelId: true,
  reviewId: true,
  bountyId: true,
  bountyEntryId: true,
  questionId: true,
  answerId: true,
  model3dId: true,
  model3dReviewId: true,
  comicProjectId: true,
  comicChapterPosition: true,
  challengeId: true,
  appListingId: true,
} as const;

type ThreadContent = {
  imageId: number | null;
  postId: number | null;
  articleId: number | null;
  modelId: number | null;
  reviewId: number | null;
  bountyId: number | null;
  bountyEntryId: number | null;
  questionId: number | null;
  answerId: number | null;
  model3dId: number | null;
  model3dReviewId: number | null;
  comicProjectId: number | null;
  comicChapterPosition: number | null;
  challengeId: number | null;
  appListingId: number | null;
};

async function ownerOfThreadContent(thread: ThreadContent | null): Promise<number | undefined> {
  if (!thread) return undefined;
  if (thread.imageId)
    return (
      await guardDb.image.findUnique({ where: { id: thread.imageId }, select: { userId: true } })
    )?.userId;
  if (thread.postId)
    return (
      await guardDb.post.findUnique({ where: { id: thread.postId }, select: { userId: true } })
    )?.userId;
  if (thread.articleId)
    return (
      await guardDb.article.findUnique({
        where: { id: thread.articleId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.modelId)
    return (
      await guardDb.model.findUnique({ where: { id: thread.modelId }, select: { userId: true } })
    )?.userId;
  if (thread.reviewId)
    return (
      await guardDb.resourceReview.findUnique({
        where: { id: thread.reviewId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.bountyId)
    return (
      (
        await guardDb.bounty.findUnique({
          where: { id: thread.bountyId },
          select: { userId: true },
        })
      )?.userId ?? undefined
    );
  if (thread.bountyEntryId)
    return (
      (
        await guardDb.bountyEntry.findUnique({
          where: { id: thread.bountyEntryId },
          select: { userId: true },
        })
      )?.userId ?? undefined
    );
  if (thread.questionId)
    return (
      await guardDb.question.findUnique({
        where: { id: thread.questionId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.answerId)
    return (
      await guardDb.answer.findUnique({ where: { id: thread.answerId }, select: { userId: true } })
    )?.userId;
  if (thread.model3dId)
    return (
      await guardDb.model3D.findUnique({
        where: { id: thread.model3dId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.model3dReviewId)
    return (
      await guardDb.model3DReview.findUnique({
        where: { id: thread.model3dReviewId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.comicProjectId)
    return (
      await guardDb.comicProject.findUnique({
        where: { id: thread.comicProjectId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.challengeId)
    return (
      (
        await guardDb.challenge.findUnique({
          where: { id: thread.challengeId },
          select: { createdById: true },
        })
      )?.createdById ?? undefined
    );
  if (thread.appListingId)
    return (
      await guardDb.appListing.findUnique({
        where: { serialId: thread.appListingId },
        select: { userId: true },
      })
    )?.userId;
  return undefined;
}

type RootOwner = { resolved: false } | { resolved: true; ownerId: number | undefined };

/**
 * The owner of the content at the top of a thread's stored `Thread.commentId -> CommentV2.threadId`
 * chain, never `Thread.rootThreadId`, which the first replier writes from client input.
 *
 * Unresolved when the chain ends anywhere but a content thread: an orphan left by a deleted
 * comment, or the depth cap. What that means is the caller's decision.
 */
async function rootOwnerOfThread(threadId: number): Promise<RootOwner> {
  const [top] = await guardDb.$queryRaw<{ id: number; rooted: boolean }[]>`
    ${Prisma.raw(muteableThreadsCte(String(Number(threadId))))}
    SELECT top."id", ${threadIsRooted('th')} "rooted"
    FROM (SELECT mt."id" FROM muteable_threads mt ORDER BY mt."depth" DESC LIMIT 1) top
    JOIN "Thread" th ON th.id = top."id"
  `;
  if (!top?.rooted) return { resolved: false };
  const rootThread = await guardDb.thread.findUnique({
    where: { id: top.id },
    select: threadContentSelect,
  });
  return { resolved: true, ownerId: await ownerOfThreadContent(rootThread) };
}

/**
 * The owner of the content a stored comment ultimately belongs to — never the author of the
 * comment a reply answers, who is not the content owner and must not moderate replies to them.
 * An unresolved chain has no owner, which leaves the comment to moderators.
 */
export async function getContentOwnerIdForComment(commentId: number) {
  const comment = await guardDb.commentV2.findUnique({
    where: { id: commentId },
    select: { hidden: true, threadId: true },
  });
  if (!comment) throw throwNotFoundError(`No comment with id ${commentId}`);

  const root = await rootOwnerOfThread(comment.threadId);
  return { hidden: comment.hidden ?? false, ownerId: root.resolved ? root.ownerId : undefined };
}

/**
 * Block targets for acting on CommentV2 `commentId`: its author and the root content owner.
 *
 * `authorOnly` suits reactions, which no lock walk guards and which legitimately land on comments
 * in orphaned chains. Comment writes `refuse`, matching `throwIfThreadChainLocked`.
 */
async function ownersForCommentV2(
  commentId: number,
  onUnresolved: 'refuse' | 'authorOnly'
): Promise<number[]> {
  const comment = await guardDb.commentV2.findUnique({
    where: { id: commentId },
    select: { userId: true, threadId: true },
  });
  if (!comment) throw throwNotFoundError(`No comment with id ${commentId}`);
  const ids = new Set<number>([comment.userId]);
  const root = await rootOwnerOfThread(comment.threadId);
  if (!root.resolved && onUnresolved === 'refuse')
    throw throwBadRequestError(UNRESOLVED_THREAD_CHAIN_MESSAGE);
  if (root.resolved && root.ownerId) ids.add(root.ownerId);
  return [...ids];
}

/** Owners to check when creating a reply to CommentV2 `parentCommentId`. */
export async function getBlockCheckOwnerIdsForReply(parentCommentId: number): Promise<number[]> {
  return ownersForCommentV2(parentCommentId, 'refuse');
}

/**
 * Owners to check when editing an EXISTING comment.
 *
 * The request's `entityType`/`entityId` are client-supplied and never verified against the comment
 * being edited — the update is scoped by comment id alone — so an edit must resolve its target from
 * the stored comment. Trusting the request instead would let a blocked user aim the check at an
 * entity with no owner and edit freely.
 *
 * Resolves the same targets the create path checks: for a reply, the parent comment's author and
 * the root content owner; for a top-level comment, the content owner. The editor's own id may come
 * back among them — `throwIfBlockedByOwners` skips self.
 */
export async function getBlockCheckOwnerIdsForComment(commentId: number): Promise<number[]> {
  const comment = await guardDb.commentV2.findUnique({
    where: { id: commentId },
    select: { threadId: true, thread: { select: { commentId: true } } },
  });
  if (!comment) throw throwNotFoundError(`No comment with id ${commentId}`);

  const root = await rootOwnerOfThread(comment.threadId);
  if (!root.resolved) throw throwBadRequestError(UNRESOLVED_THREAD_CHAIN_MESSAGE);

  const ids = new Set<number>();
  const parentCommentId = comment.thread?.commentId;
  if (parentCommentId) {
    const parent = await guardDb.commentV2.findUnique({
      where: { id: parentCommentId },
      select: { userId: true },
    });
    if (parent) ids.add(parent.userId);
  }
  if (root.ownerId) ids.add(root.ownerId);

  return [...ids];
}

/**
 * Owners to check for a write on the legacy model-comment surface (`Comment`).
 *
 * A create is aimed by the request; an edit writes `modelId`/`parentId` through from the request
 * while being scoped by comment id alone, so an edit can re-home a comment onto another model or
 * under another parent. Both the comment's stored home and the one the request names are resolved,
 * so neither end of a move escapes the block. The writer's own id may come back among them —
 * `throwIfBlockedByOwners` skips self.
 */
export async function getBlockCheckOwnerIdsForModelComment({
  commentId,
  modelId,
  parentId,
}: {
  commentId?: number | null;
  modelId?: number | null;
  parentId?: number | null;
}): Promise<number[]> {
  const modelIds = new Set<number>();
  const parentIds = new Set<number>();
  if (modelId) modelIds.add(modelId);
  if (parentId) parentIds.add(parentId);

  if (commentId) {
    const stored = await guardDb.comment.findUnique({
      where: { id: commentId },
      select: { modelId: true, parentId: true },
    });
    if (stored) {
      modelIds.add(stored.modelId);
      if (stored.parentId) parentIds.add(stored.parentId);
    }
  }

  // Resolved through the switch rather than by reading the rows here, so a rule added to either
  // entity type (a deleted model, a transferred owner) reaches this path too. At most two ids each.
  const ids = new Set<number>();
  for (const id of modelIds)
    for (const owner of await getBlockCheckOwnerIds({ entityType: 'model', entityId: id }))
      ids.add(owner);
  for (const id of parentIds)
    for (const owner of await getBlockCheckOwnerIds({ entityType: 'commentOld', entityId: id }))
      ids.add(owner);
  return [...ids];
}

// Resolves the content owner user id(s) relevant to an interaction on a given
// entity, so we can enforce user-blocking on write paths (comment/reaction).
export async function getBlockCheckOwnerIds({
  entityType,
  entityId,
}: {
  entityType: BlockCheckEntityType;
  entityId: number;
}): Promise<number[]> {
  switch (entityType) {
    case 'image': {
      const r = await guardDb.image.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'post': {
      const r = await guardDb.post.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'article': {
      const r = await guardDb.article.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'model': {
      const r = await guardDb.model.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'review':
    case 'resourceReview': {
      const r = await guardDb.resourceReview.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'question': {
      const r = await guardDb.question.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'answer': {
      const r = await guardDb.answer.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'bounty': {
      const r = await guardDb.bounty.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r?.userId ? [r.userId] : [];
    }
    case 'bountyEntry': {
      const r = await guardDb.bountyEntry.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r?.userId ? [r.userId] : [];
    }
    case 'commentOld': {
      // Author AND the owner of the model the comment hangs off, mirroring `comment` above. The
      // author alone still let a blocked user interact under a blocker's model, as long as the
      // comment they aimed at belonged to somebody else.
      const r = await guardDb.comment.findUnique({
        where: { id: entityId },
        select: { userId: true, modelId: true },
      });
      if (!r) return [];
      const ids = new Set<number>([r.userId]);
      for (const owner of await getBlockCheckOwnerIds({ entityType: 'model', entityId: r.modelId }))
        ids.add(owner);
      return [...ids];
    }
    case 'model3d': {
      const r = await guardDb.model3D.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'model3dReview': {
      const r = await guardDb.model3DReview.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'comicChapter': {
      const r = await guardDb.comicChapter.findUnique({
        where: { id: entityId },
        select: { project: { select: { userId: true } } },
      });
      return r?.project?.userId ? [r.project.userId] : [];
    }
    case 'challenge': {
      const r = await guardDb.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      return r?.createdById ? [r.createdById] : [];
    }
    case 'appListing': {
      // Threads key off the INTEGER surrogate, so `entityId` here is `serialId`,
      // not the listing's ULID `id`.
      const r = await guardDb.appListing.findUnique({
        where: { serialId: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'comment':
      return ownersForCommentV2(entityId, 'authorOnly');
    default:
      // Compile-time exhaustiveness: a new comment/reaction entity type fails to
      // build here until it resolves an owner. Runtime still yields "no owner"
      // rather than throwing, so an unexpected value can't take a write path down.
      entityType satisfies never;
      return [];
  }
}

export async function throwIfBlockedByOwners({
  userId,
  ownerIds,
  isModerator,
}: {
  userId: number;
  ownerIds: Array<number | null | undefined>;
  isModerator?: boolean;
}) {
  if (isModerator) return;
  for (const ownerId of ownerIds) {
    if (!ownerId || ownerId === userId) continue;
    const blocked = await amIBlockedByUser({ userId, targetUserId: ownerId });
    if (blocked) throw throwNotFoundError();
  }
}

// Throws NotFound (mirroring the read-side block enforcement) when `userId` is
// blocked by the owner of the content they're trying to interact with.
export async function throwIfBlockedByEntityOwner({
  userId,
  entityType,
  entityId,
  isModerator,
}: {
  userId: number;
  entityType: BlockCheckEntityType;
  entityId: number;
  isModerator?: boolean;
}) {
  if (isModerator) return;
  const ownerIds = await getBlockCheckOwnerIds({ entityType, entityId });
  await throwIfBlockedByOwners({ userId, ownerIds, isModerator });
}
