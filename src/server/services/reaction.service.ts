import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ToggleReactionInput, ReactionEntityType } from './../schema/reaction.schema';
import { prisma } from '~/server/db/client';
import { queueMetricUpdate } from '~/server/jobs/update-metrics';

export const toggleReaction = async ({
  entityType,
  entityId,
  userId,
  reaction,
}: ToggleReactionInput & { userId: number }) => {
  const existing = await getReaction({ entityType, entityId, userId, reaction });
  if (existing) return await deleteReaction({ entityType, id: existing.id, entityId });
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
  entityId,
  id,
}: {
  entityType: ReactionEntityType;
  entityId: number;
  id: number;
}) => {
  switch (entityType) {
    case 'question':
      await prisma.questionReaction.deleteMany({ where: { id } });
      await queueMetricUpdate('Question', entityId);
      return;
    case 'answer':
      await prisma.answerReaction.deleteMany({ where: { id } });
      await queueMetricUpdate('Answer', entityId);
      return;
    case 'comment':
      await prisma.commentV2Reaction.deleteMany({ where: { id } });
      return;
    case 'image':
      await prisma.imageReaction.deleteMany({ where: { id } });
      await queueMetricUpdate('Image', entityId);
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
