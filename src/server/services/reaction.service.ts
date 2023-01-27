import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ToggleReactionInput, ReactionEntityType } from './../schema/reaction.schema';
import { prisma } from '~/server/db/client';

export const toggleReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) => {
  const existing = await getReaction({ entityType, entityId, userId, reaction });
  if (existing) return await deleteReaction({ entityType, id: existing.id });
  else return await createReaction({ entityType, entityId, userId, reaction });
};

const getReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) => {
  switch (entityType) {
    case 'question':
      return await prisma.questionReaction.findFirst({
        where: { userId, reaction, questionId: entityId },
        select: { id: true },
      });
    case 'answer':
      return await prisma.answerReaction.findFirst({
        where: { userId, reaction, answerId: entityId },
        select: { id: true },
      });
    case 'comment':
      return await prisma.commentV2Reaction.findFirst({
        where: { userId, reaction, commentId: entityId },
        select: { id: true },
      });
    case 'image':
      return await prisma.imageReaction.findFirst({
        where: { userId, reaction, imageId: entityId },
        select: { id: true },
      });
    default:
      throw throwBadRequestError();
  }
};

const deleteReaction = async ({
  entityType,
  id,
}: {
  entityType: ReactionEntityType;
  id: number;
}) => {
  switch (entityType) {
    case 'question':
      return await prisma.questionReaction.delete({ where: { id }, select: { reaction: true } });
    case 'answer':
      return await prisma.answerReaction.delete({ where: { id }, select: { reaction: true } });
    case 'comment':
      return await prisma.commentV2Reaction.delete({ where: { id }, select: { reaction: true } });
    case 'image':
      return await prisma.imageReaction.delete({ where: { id }, select: { reaction: true } });
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
      return await prisma.questionReaction.create({
        data: { ...data, questionId: entityId },
        select: { reaction: true },
      });
    case 'answer':
      return await prisma.answerReaction.create({
        data: { ...data, answerId: entityId },
        select: { reaction: true },
      });
    case 'comment':
      return await prisma.commentV2Reaction.create({
        data: { ...data, commentId: entityId },
        select: { reaction: true },
      });
    case 'image':
      return await prisma.imageReaction.create({
        data: { ...data, imageId: entityId },
        select: { reaction: true },
      });
    default:
      throw throwBadRequestError();
  }
};
