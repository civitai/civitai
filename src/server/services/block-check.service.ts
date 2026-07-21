import { dbRead } from '~/server/db/client';
import { amIBlockedByUser } from '~/server/services/user.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';

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
  return undefined;
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
  const thread = comment.thread;
  if (thread) {
    const rootContent = thread.rootThreadId
      ? await dbRead.thread.findUnique({
          where: { id: thread.rootThreadId },
          select: threadContentSelect,
        })
      : thread;
    const rootOwner = await ownerOfThreadContent(rootContent);
    if (rootOwner) ids.add(rootOwner);
  }
  return [...ids];
}

// Resolves the content owner user id(s) relevant to an interaction on a given
// entity, so we can enforce user-blocking on write paths (comment/reaction).
export async function getBlockCheckOwnerIds({
  entityType,
  entityId,
}: {
  entityType: string;
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
    case 'comment':
      return ownersForCommentV2(entityId);
    default:
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
  entityType: string;
  entityId: number;
  isModerator?: boolean;
}) {
  if (isModerator) return;
  const ownerIds = await getBlockCheckOwnerIds({ entityType, entityId });
  await throwIfBlockedByOwners({ userId, ownerIds });
}
