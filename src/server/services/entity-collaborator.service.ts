import { ChatMessageType, EntityType, Prisma, EntityCollaboratorStatus } from '@prisma/client';
import dayjs from 'dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetEntityCollaboratorsInput,
  UpsertEntityCollaboratorInput,
} from '~/server/schema/entity-collaborator.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { createMessage, upsertChat } from '~/server/services/chat.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export const sendEntityCollaboratorInviteMessage = async ({
  entityType,
  entityId,
  targetUserId,
  userId,
}: Omit<UpsertEntityCollaboratorInput, 'sendMessage'> & { userId: number }) => {
  if (entityType !== EntityType.Post) {
    throw throwBadRequestError('Only posts are currently supported for entity collaborators');
  }

  const inviter = await dbRead.user.findUnique({ where: { id: userId } });
  const invitee = await dbRead.user.findUnique({ where: { id: targetUserId } });

  if (!inviter) {
    throw throwBadRequestError('Inviter not found');
  }

  if (!invitee) {
    throw throwBadRequestError('Invitee not found');
  }

  const chat = await upsertChat({
    userIds: [userId, targetUserId],
    isModerator: false,
    isSupporter: false,
    userId,
  });

  if (!chat) {
    throw throwBadRequestError('Unable to invite collaborator');
  }

  const url = `/collaborations/${entityType}/${entityId}`;

  switch (entityType) {
    case EntityType.Post:
      const targetUrl = `/posts/${entityId}`;
      const message = `${inviter.username} has invited ${invitee.username} to be posted as a collaborator on [this](${targetUrl}) post. Click [here](${url}) to accept or reject the invitation.`;
      // Confirm a chat exists:
      await createMessage({
        chatId: chat.id,
        content: message,
        userId: -1, // We want this to be a system message.
        contentType: ChatMessageType.Markdown,
      });

    default:
      return;
  }
};

export const upsertEntityCollaborator = async ({
  entityType,
  entityId,
  sendMessage,
  targetUserId,
  userId,
  isModerator,
}: UpsertEntityCollaboratorInput & { userId: number; isModerator?: boolean }) => {
  if (entityType !== EntityType.Post) {
    throw throwBadRequestError('Only posts are currently supported for entity collaborators');
  }

  const entity = await dbRead.post.findUnique({ where: { id: entityId } });
  if (!entity) {
    throw throwBadRequestError('Entity not found');
  }

  if (entity.userId !== userId && !isModerator) {
    throw throwAuthorizationError('Only the owner of the post can add collaborators');
  }

  const existingRecord = await dbRead.entityCollaborator.findFirst({
    where: { entityId, entityType, userId: targetUserId },
  });

  if (existingRecord && sendMessage) {
    if (
      existingRecord.status === EntityCollaboratorStatus.Pending &&
      // You can send the message at most once a day
      (!existingRecord.lastMessageSentAt ||
        existingRecord.lastMessageSentAt >= dayjs().subtract(1, 'day').toDate())
    ) {
      await sendEntityCollaboratorInviteMessage({
        entityId,
        entityType,
        targetUserId,
        userId,
      });
    }
    return existingRecord;
  }

  const newRecord = await dbWrite.entityCollaborator.create({
    data: {
      entityId,
      entityType,
      userId: targetUserId,
      createdBy: userId,
      lastMessageSentAt: sendMessage ? new Date() : null,
    },
  });

  if (sendMessage) {
    await sendEntityCollaboratorInviteMessage({
      entityId,
      entityType,
      targetUserId,
      userId,
    });
  }

  return newRecord;
};

export const getEntityCollaborators = async ({
  entityId,
  entityType,
  userId,
  isModerator,
}: GetEntityCollaboratorsInput & {
  userId?: number;
  isModerator?: boolean;
}) => {
  if (entityType !== EntityType.Post) {
    return []; // Just return empty array in the meantime. As we support more types, we'll be adding more stuff here.
  }

  switch (entityType) {
    case EntityType.Post:
      const entity = await dbRead.post.findUnique({ where: { id: entityId } });
      if (!entity) {
        throw throwBadRequestError('Entity not found');
      }

      const collaborators = await dbRead.entityCollaborator.findMany({
        where: { entityId, entityType },
        select: {
          user: {
            select: userWithCosmeticsSelect,
          },
          status: true,
        },
      });

      return collaborators.filter((collaborator) => {
        if (collaborator.status === EntityCollaboratorStatus.Approved) {
          return true;
        }

        if (!userId && !isModerator) {
          return false;
        }

        if (collaborator.status === EntityCollaboratorStatus.Pending) {
          return entity.userId === userId || collaborator.user.id === userId || isModerator;
        }

        if (collaborator.status === EntityCollaboratorStatus.Rejected) {
          return entity.userId === userId || isModerator;
        }

        return false;
      });

    default:
      return [];
  }
};
