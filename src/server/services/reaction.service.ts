import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ToggleReactionInput, ReactionEntityType } from './../schema/reaction.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { playfab } from '~/server/playfab/client';
import {
  answerMetrics,
  articleMetrics,
  bountyEntryMetrics,
  clubPostMetrics,
  imageMetrics,
  postMetrics,
  questionMetrics,
} from '~/server/metrics';
import { ReviewReactions } from '@prisma/client';

export const toggleReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) => {
  const existing = await getReaction({ entityType, entityId, userId, reaction });
  if (existing) {
    await deleteReaction({
      entityType,
      id: 'id' in existing ? existing.id : undefined,
      entityId,
      userId,
      reaction,
    });
    return 'removed';
  } else {
    await createReaction({ entityType, entityId, userId, reaction });
    await playfab.trackEvent(userId, {
      eventName: `user_react_${entityType}`,
      id: entityId,
      reaction,
    });
    return 'created';
  }
};

const getReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) => {
  switch (entityType) {
    case 'question':
      return await dbRead.questionReaction.findFirst({
        where: { userId, reaction, questionId: entityId },
        select: { id: true },
      });
    case 'answer':
      return await dbRead.answerReaction.findFirst({
        where: { userId, reaction, answerId: entityId },
        select: { id: true },
      });
    case 'commentOld':
      return await dbRead.commentReaction.findFirst({
        where: { userId, reaction, commentId: entityId },
        select: { id: true },
      });
    case 'comment':
      return await dbRead.commentV2Reaction.findFirst({
        where: { userId, reaction, commentId: entityId },
        select: { id: true },
      });
    case 'image':
      return await dbRead.imageReaction.findFirst({
        where: { userId, reaction, imageId: entityId },
        select: { id: true },
      });
    case 'post':
      return await dbRead.postReaction.findFirst({
        where: { userId, reaction, postId: entityId },
        select: { id: true },
      });
    case 'resourceReview':
      return await dbRead.resourceReviewReaction.findFirst({
        where: { userId, reaction, reviewId: entityId },
        select: { id: true },
      });
    case 'article':
      return await dbRead.articleReaction.findFirst({
        where: { userId, reaction, articleId: entityId },
        select: { id: true },
      });
    case 'bountyEntry':
      return await dbRead.bountyEntryReaction.findFirst({
        where: { userId, reaction, bountyEntryId: entityId },
        select: { userId: true },
      });
    case 'clubPost':
      return await dbRead.clubPostReaction.findFirst({
        where: { userId, reaction, clubPostId: entityId },
        select: { userId: true },
      });
    default:
      throw throwBadRequestError();
  }
};

const deleteReaction = async ({
  entityType,
  entityId,
  id,
  reaction,
  userId,
}: {
  entityType: ReactionEntityType;
  entityId: number;
  id?: number;
  reaction?: ReviewReactions;
  userId?: number;
}) => {
  switch (entityType) {
    case 'question':
      if (!id) {
        return;
      }
      await dbWrite.questionReaction.deleteMany({ where: { id } });
      await questionMetrics.queueUpdate(entityId);
      return;
    case 'answer':
      if (!id) {
        return;
      }
      await dbWrite.answerReaction.deleteMany({ where: { id } });
      await answerMetrics.queueUpdate(entityId);
      return;
    case 'commentOld':
      if (!id) {
        return;
      }
      await dbWrite.commentReaction.deleteMany({ where: { id } });
      return;
    case 'comment':
      if (!id) {
        return;
      }
      await dbWrite.commentV2Reaction.deleteMany({ where: { id } });
      return;
    case 'image':
      if (!id) {
        return;
      }
      await dbWrite.imageReaction.deleteMany({ where: { id } });
      await imageMetrics.queueUpdate(entityId);
      return;
    case 'post':
      if (!id) {
        return;
      }
      await dbWrite.postReaction.deleteMany({ where: { id } });
      await postMetrics.queueUpdate(entityId);
      return;
    case 'resourceReview':
      if (!id) {
        return;
      }
      await dbWrite.resourceReviewReaction.deleteMany({ where: { id } });
      return;
    case 'article':
      if (!id) {
        return;
      }
      await dbWrite.articleReaction.deleteMany({ where: { id } });
      await articleMetrics.queueUpdate(entityId);
      return;
    case 'bountyEntry':
      if (!entityId || !userId || !reaction) {
        return;
      }

      await dbWrite.bountyEntryReaction.deleteMany({
        where: { userId, reaction, bountyEntryId: entityId },
      });
      await bountyEntryMetrics.queueUpdate(entityId);
      return;
    case 'clubPost':
      if (!entityId || !userId || !reaction) {
        return;
      }

      await dbWrite.clubPostReaction.deleteMany({
        where: { userId, reaction, clubPostId: entityId },
      });
      await clubPostMetrics.queueUpdate(entityId);
      return;
    default:
      throw throwBadRequestError();
  }
};

const createReaction = async ({
  entityType,
  entityId,
  ...data
}: ToggleReactionInput & { userId: number }) => {
  switch (entityType) {
    case 'question':
      return await dbWrite.questionReaction.create({
        data: { ...data, questionId: entityId },
        select: { reaction: true },
      });
    case 'answer':
      return await dbWrite.answerReaction.create({
        data: { ...data, answerId: entityId },
        select: { reaction: true },
      });
    case 'commentOld':
      return await dbWrite.commentReaction.create({
        data: { ...data, commentId: entityId },
        select: { reaction: true },
      });
    case 'comment':
      return await dbWrite.commentV2Reaction.create({
        data: { ...data, commentId: entityId },
        select: { reaction: true },
      });
    case 'image':
      return await dbWrite.imageReaction.create({
        data: { ...data, imageId: entityId },
        select: { reaction: true },
      });
    case 'post':
      return await dbWrite.postReaction.create({
        data: { ...data, postId: entityId },
        select: { reaction: true },
      });
    case 'resourceReview':
      return await dbWrite.resourceReviewReaction.create({
        data: { ...data, reviewId: entityId },
        select: { reaction: true },
      });
    case 'article':
      return await dbWrite.articleReaction.create({
        data: { ...data, articleId: entityId },
        select: { reaction: true },
      });
    case 'bountyEntry':
      return await dbWrite.bountyEntryReaction.create({
        data: { ...data, bountyEntryId: entityId },
        select: { reaction: true },
      });
    case 'clubPost':
      return await dbWrite.clubPostReaction.create({
        data: { ...data, clubPostId: entityId },
        select: { reaction: true },
      });
    default:
      throw throwBadRequestError();
  }
};
