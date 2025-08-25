import { Prisma } from '@prisma/client';
import { ChatMessageType, EntityType, EntityCollaboratorStatus } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  GetEntityCollaboratorsInput,
  RemoveEntityCollaboratorInput,
  UpsertEntityCollaboratorInput,
  ActionEntityCollaboratorInviteInput,
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

  switch (entityType) {
    case EntityType.Post:
      const targetUrl = `/posts/${entityId}`;
      const message = `**${inviter.username}** invited **${invitee.username}** to be included as a collaborator on [this](${targetUrl}) post. The invitation can be accepted or rejected via the Post's link.`;
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

  const totalCollaborators = await dbRead.entityCollaborator.count({
    where: { entityId, entityType },
  });

  if (totalCollaborators >= constants.entityCollaborators.maxCollaborators) {
    throw throwBadRequestError(
      `You can only have up to ${constants.entityCollaborators.maxCollaborators} collaborators`
    );
  }

  const newRecord = await dbWrite.entityCollaborator.upsert({
    where: {
      entityType_entityId_userId: {
        entityId,
        entityType,
        userId: targetUserId,
      },
    },
    update: {
      lastMessageSentAt: sendMessage ? new Date() : undefined,
    },
    create: {
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
        return [];
      }

      const collaborators = await dbRead.entityCollaborator.findMany({
        where: { entityId, entityType },
        select: {
          user: {
            select: userWithCosmeticsSelect,
          },
          entityId: true,
          entityType: true,
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

export const removeEntityCollaborator = async ({
  targetUserId,
  entityId,
  entityType,
  isModerator,
  userId,
}: RemoveEntityCollaboratorInput & { userId: number; isModerator?: boolean }) => {
  if (entityType !== EntityType.Post) {
    throw throwBadRequestError('Only posts are currently supported for entity collaborators');
  }

  const entity = await dbRead.post.findUnique({ where: { id: entityId } });

  if (!entity) {
    throw throwBadRequestError('Entity not found');
  }

  const collaborator = await dbRead.entityCollaborator.findFirst({
    where: { entityId, entityType, userId: targetUserId },
  });

  if (!collaborator) {
    return true;
  }

  if (entity.userId !== userId && !isModerator) {
    throw throwAuthorizationError('Only the owner of the post can remove collaborators');
  }

  await dbWrite.entityCollaborator.delete({
    where: {
      entityType_entityId_userId: {
        entityId,
        entityType,
        userId: targetUserId,
      },
    },
  });

  return true;
};

export const actionEntityCollaborationInvite = async ({
  entityId,
  entityType,
  status,
  userId,
}: ActionEntityCollaboratorInviteInput & { userId: number }) => {
  const exists = await dbRead.entityCollaborator.findFirst({
    where: { entityId, entityType, userId },
  });

  if (!exists) {
    throw throwBadRequestError('Collaboration request not found');
  }

  await dbWrite.entityCollaborator.update({
    where: {
      entityType_entityId_userId: {
        entityId,
        entityType,
        userId,
      },
    },
    data: {
      status,
    },
  });

  return dbWrite.entityCollaborator.findFirst({
    where: { entityId, entityType, userId },
    select: {
      entityId: true,
      entityType: true,
      status: true,
      user: {
        select: userWithCosmeticsSelect,
      },
    },
  });
};

export const sendMessagesToCollaborators = async ({
  entityId,
  entityType,
  userId,
}: {
  entityId: number;
  entityType: EntityType;
  userId: number;
}) => {
  if (entityType !== EntityType.Post) {
    throw throwBadRequestError('Only posts are currently supported for entity collaborators');
  }

  const validCollaborators = await dbRead.entityCollaborator.findMany({
    where: {
      entityId,
      entityType,
      status: EntityCollaboratorStatus.Pending,
      AND: {
        OR: [
          {
            lastMessageSentAt: null,
          },
          {
            lastMessageSentAt: { lte: dayjs().subtract(1, 'day').toDate() },
          },
        ],
      },
    },
  });

  await Promise.all(
    validCollaborators.map((c) =>
      sendEntityCollaboratorInviteMessage({
        entityId,
        entityType,
        targetUserId: c.userId,
        userId,
      })
    )
  );

  return;
};
