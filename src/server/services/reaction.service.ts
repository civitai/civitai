import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ToggleReactionInput, ReactionEntityType } from './../schema/reaction.schema';
import { dbWrite, dbRead } from '~/server/db/client';
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
      return await dbRead.questionReaction.findFirst({
        where: { userId, reaction, questionId: entityId },
        select: { id: true },
      });
    case 'answer':
      return await dbRead.answerReaction.findFirst({
        where: { userId, reaction, answerId: entityId },
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
      await dbWrite.questionReaction.deleteMany({ where: { id } });
      await queueMetricUpdate('Question', entityId);
      return;
    case 'answer':
      await dbWrite.answerReaction.deleteMany({ where: { id } });
      await queueMetricUpdate('Answer', entityId);
      return;
    case 'comment':
      await dbWrite.commentV2Reaction.deleteMany({ where: { id } });
      return;
    case 'image':
      await dbWrite.imageReaction.deleteMany({ where: { id } });
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
      return await dbWrite.questionReaction.create({
        data: { ...data, questionId: entityId },
        select: { reaction: true },
      });
    case 'answer':
      return await dbWrite.answerReaction.create({
        data: { ...data, answerId: entityId },
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
    default:
      throw throwBadRequestError();
  }
};
