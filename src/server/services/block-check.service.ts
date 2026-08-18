import { dbRead } from '~/server/db/client';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import type { ReactionEntityType } from '~/server/schema/reaction.schema';
import { amIBlockedByUser } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Every entity type any write path can hand the owner resolver: comment surfaces
 * plus reaction surfaces. Adding a member to either enum breaks the switch in
 * `getBlockCheckOwnerIds` until an owner is resolved for it.
 */
export type BlockCheckEntityType = CommentConnectorInput['entityType'] | ReactionEntityType;

// Must list EVERY owner-bearing FK on `Thread`. A column missing here resolves no
// root owner for replies in that kind of thread, silently skipping the block.
const threadContentSelect = {
  rootThreadId: true,
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
  rootThreadId: number | null;
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
      await dbRead.image.findUnique({ where: { id: thread.imageId }, select: { userId: true } })
    )?.userId;
  if (thread.postId)
    return (
      await dbRead.post.findUnique({ where: { id: thread.postId }, select: { userId: true } })
    )?.userId;
  if (thread.articleId)
    return (
      await dbRead.article.findUnique({ where: { id: thread.articleId }, select: { userId: true } })
    )?.userId;
  if (thread.modelId)
    return (
      await dbRead.model.findUnique({ where: { id: thread.modelId }, select: { userId: true } })
    )?.userId;
  if (thread.reviewId)
    return (
      await dbRead.resourceReview.findUnique({
        where: { id: thread.reviewId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.bountyId)
    return (
      (await dbRead.bounty.findUnique({ where: { id: thread.bountyId }, select: { userId: true } }))
        ?.userId ?? undefined
    );
  if (thread.bountyEntryId)
    return (
      (
        await dbRead.bountyEntry.findUnique({
          where: { id: thread.bountyEntryId },
          select: { userId: true },
        })
      )?.userId ?? undefined
    );
  if (thread.questionId)
    return (
      await dbRead.question.findUnique({
        where: { id: thread.questionId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.answerId)
    return (
      await dbRead.answer.findUnique({ where: { id: thread.answerId }, select: { userId: true } })
    )?.userId;
  if (thread.model3dId)
    return (
      await dbRead.model3D.findUnique({ where: { id: thread.model3dId }, select: { userId: true } })
    )?.userId;
  if (thread.model3dReviewId)
    return (
      await dbRead.model3DReview.findUnique({
        where: { id: thread.model3dReviewId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.comicProjectId)
    return (
      await dbRead.comicProject.findUnique({
        where: { id: thread.comicProjectId },
        select: { userId: true },
      })
    )?.userId;
  if (thread.challengeId)
    return (
      (
        await dbRead.challenge.findUnique({
          where: { id: thread.challengeId },
          select: { createdById: true },
        })
      )?.createdById ?? undefined
    );
  if (thread.appListingId)
    return (
      await dbRead.appListing.findUnique({
        where: { serialId: thread.appListingId },
        select: { userId: true },
      })
    )?.userId;
  return undefined;
}

/**
 * The owner of the content a thread ultimately hangs off — the root thread's entity for a reply,
 * the thread's own for a top-level comment.
 */
async function rootOwnerOfThread(thread: ThreadContent): Promise<number | undefined> {
  const rootContent = thread.rootThreadId
    ? await dbRead.thread.findUnique({
        where: { id: thread.rootThreadId },
        select: threadContentSelect,
      })
    : thread;
  return ownerOfThreadContent(rootContent);
}

// For a CommentV2 reply target, block if blocked by the parent comment's author
// OR by the owner of the root content the thread hangs off of.
async function ownersForCommentV2(commentId: number): Promise<number[]> {
  const comment = await dbRead.commentV2.findUnique({
    where: { id: commentId },
    select: { userId: true, thread: { select: threadContentSelect } },
  });
  if (!comment) return [];
  const ids = new Set<number>([comment.userId]);
  if (comment.thread) {
    const rootOwner = await rootOwnerOfThread(comment.thread);
    if (rootOwner) ids.add(rootOwner);
  }
  return [...ids];
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
  const comment = await dbRead.commentV2.findUnique({
    where: { id: commentId },
    select: { thread: { select: { commentId: true, ...threadContentSelect } } },
  });
  const thread = comment?.thread;
  if (!thread) return [];

  const ids = new Set<number>();
  // A reply's parent author is a target too, matching the create path. Only the author is needed —
  // the parent hangs off the same root, resolved once below.
  if (thread.commentId) {
    const parent = await dbRead.commentV2.findUnique({
      where: { id: thread.commentId },
      select: { userId: true },
    });
    if (parent) ids.add(parent.userId);
  }

  const rootOwner = await rootOwnerOfThread(thread);
  if (rootOwner) ids.add(rootOwner);

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
    const stored = await dbRead.comment.findUnique({
      where: { id: commentId },
      select: { modelId: true, parentId: true },
    });
    if (stored) {
      modelIds.add(stored.modelId);
      if (stored.parentId) parentIds.add(stored.parentId);
    }
  }

  const ids = new Set<number>();
  if (modelIds.size) {
    const models = await dbRead.model.findMany({
      where: { id: { in: [...modelIds] } },
      select: { userId: true },
    });
    for (const model of models) ids.add(model.userId);
  }
  if (parentIds.size) {
    const parents = await dbRead.comment.findMany({
      where: { id: { in: [...parentIds] } },
      select: { userId: true },
    });
    for (const parent of parents) ids.add(parent.userId);
  }
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
      const r = await dbRead.image.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'post': {
      const r = await dbRead.post.findUnique({ where: { id: entityId }, select: { userId: true } });
      return r ? [r.userId] : [];
    }
    case 'article': {
      const r = await dbRead.article.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'model': {
      const r = await dbRead.model.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'review':
    case 'resourceReview': {
      const r = await dbRead.resourceReview.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'question': {
      const r = await dbRead.question.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'answer': {
      const r = await dbRead.answer.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'bounty': {
      const r = await dbRead.bounty.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r?.userId ? [r.userId] : [];
    }
    case 'bountyEntry': {
      const r = await dbRead.bountyEntry.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r?.userId ? [r.userId] : [];
    }
    case 'commentOld': {
      const r = await dbRead.comment.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'model3d': {
      const r = await dbRead.model3D.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'model3dReview': {
      const r = await dbRead.model3DReview.findUnique({
        where: { id: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'comicChapter': {
      const r = await dbRead.comicChapter.findUnique({
        where: { id: entityId },
        select: { project: { select: { userId: true } } },
      });
      return r?.project?.userId ? [r.project.userId] : [];
    }
    case 'challenge': {
      const r = await dbRead.challenge.findUnique({
        where: { id: entityId },
        select: { createdById: true },
      });
      return r?.createdById ? [r.createdById] : [];
    }
    case 'appListing': {
      // Threads key off the INTEGER surrogate, so `entityId` here is `serialId`,
      // not the listing's ULID `id`.
      const r = await dbRead.appListing.findUnique({
        where: { serialId: entityId },
        select: { userId: true },
      });
      return r ? [r.userId] : [];
    }
    case 'comment':
      return ownersForCommentV2(entityId);
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
