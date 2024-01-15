import { ChatMemberStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { uniq } from 'lodash-es';
import { env } from '~/env/server.mjs';
import { SignalMessages } from '~/server/common/enums';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  AddUsersInput,
  CreateChatInput,
  CreateMessageInput,
  GetInfiniteMessagesInput,
  IsTypingInput,
  ModifyUserInput,
  UpdateMessageInput,
} from '~/server/schema/chat.schema';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ChatAllMessages, ChatCreateChat } from '~/types/router';
import { isDefined } from '~/utils/type-guards';

const maxChats = 100;
const maxUsersPerChat = 10;

const singleChatSelect = {
  id: true,
  createdAt: true,
  hash: true,
  ownerId: true,
  chatMembers: {
    where: { status: { in: [ChatMemberStatus.Joined, ChatMemberStatus.Invited] } },
    select: {
      id: true,
      userId: true,
      isOwner: true,
      isMuted: true,
      status: true,
      lastViewedMessageId: true,
      createdAt: true,
      joinedAt: true,
      leftAt: true,
      kickedAt: true,
      unkickedAt: true,
      user: {
        select: {
          id: true,
          username: true,
          image: true, // TODO is this right? or profilePicture?
        },
      },
    },
  },
  // messages: {}
};

// TODO are we using this?

/**
 * Get a single chat
 */
export const getChatHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const chat = await dbWrite.chat.findFirst({
      where: {
        id: input.id,
        // chatMembers: { some: { userId } } // TODO if enabling, remove "includes" check below
      },
      select: singleChatSelect,
    });

    if (!chat || !chat.chatMembers.map((cm) => cm.userId).includes(userId)) {
      throw throwNotFoundError(`No chat found for ID (${input.id})`);
    }

    return chat;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Get all chats for a single user
 */
export const getChatsForUserHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id: userId } = ctx.user;

    return await dbWrite.chat.findMany({
      where: { chatMembers: { some: { userId } } },
      orderBy: { createdAt: 'desc' },
      select: {
        ...singleChatSelect,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            content: true,
            contentType: true,
            // TODO is below necessary?
            // user: {
            //   select: {
            //     id: true,
            //     username: true,
            //   },
            // },
          },
        },
        // TODO figure out how to get number of unread messages here
        //  easily done with an aliased name
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Create a chat
 */
export const createChatHandler = async ({
  input,
  ctx,
}: {
  input: CreateChatInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const dedupedUserIds = uniq(input.userIds);
    if (dedupedUserIds.length < 2) {
      throw throwBadRequestError('Must choose at least 1 user');
    }
    if (dedupedUserIds.length >= maxUsersPerChat) {
      throw throwBadRequestError(`Must choose fewer than ${maxUsersPerChat - 1} users`);
    }
    if (!dedupedUserIds.includes(userId)) {
      throw throwBadRequestError('Creator must be in the chat');
    }

    dedupedUserIds.sort((a, b) => a - b);
    const hash = dedupedUserIds.join('-');

    const existing = await dbWrite.chat.findFirst({
      where: { hash },
      // select: {
      //   ...singleChatSelect,
      //   messages: {
      //     orderBy: { createdAt: 'desc' },
      //     take: 1,
      //     select: {
      //       content: true,
      //       contentType: true,
      //     },
      //   },
      // },
      select: { id: true },
    });

    if (existing) return existing;

    const totalForUser = await dbWrite.chat.count({
      where: { ownerId: userId },
    });

    // TODO need a way to archive/delete chats that will still let the users see messages
    if (totalForUser >= maxChats) {
      throw throwBadRequestError(`Cannot have more than ${maxChats} chats`);
    }

    const usersExist = await dbRead.user.count({
      where: { id: { in: dedupedUserIds } },
    });

    if (usersExist !== dedupedUserIds.length) {
      // could probably tell them which users here
      throw throwBadRequestError(
        `Some requested users do not exist (${usersExist} / ${dedupedUserIds.length})`
      );
    }

    const createdChat = await dbWrite.$transaction(async (tx) => {
      const newChat = await tx.chat.create({
        data: { hash, ownerId: userId },
        select: { id: true, createdAt: true },
      });

      await tx.chatMember.createMany({
        data: dedupedUserIds.map((u) => ({
          userId: u,
          chatId: newChat.id,
          isOwner: u === userId,
          status: u === userId ? ChatMemberStatus.Joined : ChatMemberStatus.Invited,
          joinedAt: u === userId ? newChat.createdAt : undefined,
        })),
      });

      return newChat;
    });

    for (const cmId of dedupedUserIds) {
      fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(`chat:${createdChat.id}`),
      }).catch();
    }

    // TODO I don't like the idea of querying after an insert, but it's just easier than merging all the data together
    const insertedChat = await dbWrite.chat.findFirst({
      where: {
        id: createdChat.id,
      },
      select: {
        ...singleChatSelect,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            content: true,
            contentType: true,
          },
        },
      },
    });

    fetch(
      `${env.SIGNALS_ENDPOINT}/groups/chat:${createdChat.id}/signals/${SignalMessages.ChatNewRoom}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(insertedChat as ChatCreateChat),
      }
    ).catch();

    return insertedChat;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Add a user to an existing chat
 */
export const addUsersHandler = async ({
  input,
  ctx,
}: {
  input: AddUsersInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const existing = await dbWrite.chat.findFirst({
      where: { id: input.chatId },
      select: {
        ownerId: true,
        chatMembers: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!existing) {
      throw throwBadRequestError(`Could not find chat with id: (${input.chatId})`);
    }

    if (existing.ownerId !== userId) {
      throw throwBadRequestError(`Cannot add users to a chat you are not the owner of`);
    }

    const dedupedUserIds = uniq(input.userIds);
    const existingChatMemberIds = existing.chatMembers.map((cm) => cm.userId);
    const usersToAdd = dedupedUserIds.filter((uid) => !existingChatMemberIds.includes(uid));

    const mergedUsers = [...existingChatMemberIds, ...usersToAdd];
    if (mergedUsers.length >= maxUsersPerChat) {
      throw throwBadRequestError(`Must choose fewer than ${maxUsersPerChat - 1} users`);
    }

    const usersExist = await dbRead.user.count({
      where: { id: { in: usersToAdd } },
    });

    if (usersExist !== usersToAdd.length) {
      // could probably tell them which users here
      throw throwBadRequestError(
        `Some requested users do not exist (${usersExist} / ${usersToAdd.length})`
      );
    }

    mergedUsers.sort((a, b) => a - b);
    const hash = mergedUsers.join('-');

    await dbWrite.$transaction(async (tx) => {
      await tx.chatMember.createMany({
        data: usersToAdd.map((uta) => ({
          userId: uta,
          chatId: input.chatId,
          status: ChatMemberStatus.Invited,
        })),
      });
      await tx.chat.update({
        where: { id: input.chatId },
        data: { hash },
      });
    });

    for (const cmId of usersToAdd) {
      fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(`chat:${input.chatId}`),
      }).catch();
    }

    // TODO return data?
    return;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// TODO when owner leaves chat, select new owner

/**
 * Update a member of a chat
 */
export const modifyUserHandler = async ({
  input,
  ctx,
}: {
  input: ModifyUserInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const { chatMemberId, ...rest } = input;

    if (
      rest.status === ChatMemberStatus.Kicked ||
      isDefined(rest.isMuted) ||
      isDefined(rest.lastViewedMessageId)
    ) {
      const existing = await dbWrite.chatMember.findFirst({
        where: { id: chatMemberId },
        select: {
          chat: {
            select: {
              ownerId: true,
            },
          },
        },
      });

      // i guess owners can kick themselves out :/
      if (!existing || existing.chat.ownerId !== userId) {
        throw throwBadRequestError(`Cannot modify users for a chat you are not the owner of`);
      }
    } else if (!!rest.status) {
      const existing = await dbWrite.chatMember.findFirst({
        where: { id: chatMemberId },
        select: { userId: true },
      });
      if (userId !== existing?.userId) {
        throw throwBadRequestError(`Cannot modify chat status for another user`);
      }
    }

    const extra = {
      joinedAt: rest.status === ChatMemberStatus.Joined ? new Date() : undefined,
      leftAt: rest.status === ChatMemberStatus.Left ? new Date() : undefined,
      kickedAt: rest.status === ChatMemberStatus.Kicked ? new Date() : undefined,
    };

    // TODO should we adjust the hash on leave/kicked?

    // TODO adjust membership options
    /*
      fetch(`${env.SIGNALS_ENDPOINT}/users/${chatMemberId.userId}/groups`, {
        method: 'POST', // DELETE
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(`chat:${input.chatId}`),
      }).catch();
     */

    return await dbWrite.chatMember.update({
      where: { id: chatMemberId },
      data: { ...rest, ...extra },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Get messages for a chat, intended for infinite loading
 */
export const getInfiniteMessagesHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteMessagesInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const chat = await dbWrite.chat.findFirst({
      where: { id: input.chatId },
      select: {
        chatMembers: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!chat || !chat.chatMembers.map((cm) => cm.userId).includes(userId)) {
      throw throwNotFoundError(`No chat found for ID (${input.chatId})`);
    }

    const items = await dbWrite.chatMessage.findMany({
      where: { chatId: input.chatId },
      take: input.limit + 1,
      cursor: input.cursor ? { id: input.cursor } : undefined,
      orderBy: [{ id: input.direction }],
    });

    let nextCursor: number | undefined;

    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Create a message
 */
export const createMessageHandler = async ({
  input,
  ctx,
}: {
  input: CreateMessageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const chat = await dbWrite.chat.findFirst({
      where: {
        id: input.chatId,
        // chatMembers: { some: { userId } } // TODO if enabling, remove "includes" check below
      },
      select: {
        chatMembers: {
          select: {
            userId: true,
            status: true,
          },
        },
      },
    });

    if (!chat) {
      throw throwBadRequestError(`Could not find chat with id: (${input.chatId})`);
    }

    const thisMember = chat.chatMembers.find((cm) => cm.userId === userId);

    if (!thisMember) {
      throw throwBadRequestError(`Not a member of this chat`);
    }
    if (!['Invited', 'Joined'].includes(thisMember.status)) {
      throw throwBadRequestError(`Unable to post in this chat`);
    }

    if (input.referenceMessageId) {
      const existingReference = await dbWrite.chatMessage.count({
        where: { id: input.referenceMessageId },
      });
      if (existingReference === 0) {
        throw throwBadRequestError(
          `Reference message does not exist: (${input.referenceMessageId})`
        );
      }
    }

    const resp = await dbWrite.chatMessage.create({
      data: { ...input, userId },
    });

    // for (const cm of chat.chatMembers) {
    //   if (cm.userId === userId) continue;
    //   fetch(`${env.SIGNALS_ENDPOINT}/users/${cm.userId}/signals/${SignalMessages.ChatNewMessage}`, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(resp as ChatAllMessages[number]),
    //   }).catch();
    // }

    fetch(
      `${env.SIGNALS_ENDPOINT}/groups/chat:${input.chatId}/signals/${SignalMessages.ChatNewMessage}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resp as ChatAllMessages[number]),
      }
    ).catch();

    return resp;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Update a message
 */
export const updateMessageHandler = async ({
  input,
  ctx,
}: {
  input: UpdateMessageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { messageId, ...rest } = input;

    const existingMessage = await dbWrite.chatMessage.findFirst({
      where: { id: messageId },
      select: {
        userId: true,
      },
    });

    if (!existingMessage || existingMessage.userId !== userId) {
      throw throwBadRequestError(`Could not find message with id: (${messageId})`);
    }

    // TODO signal

    return await dbWrite.chatMessage.update({
      where: { id: input.messageId },
      data: { ...rest, editedAt: new Date() },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Send isTyping signal
 */
export const isTypingHandler = async ({
  input,
  ctx,
}: {
  input: IsTypingInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const { chatId, isTyping } = input;

    const existing = await dbWrite.chat.findFirst({
      where: { id: chatId },
      select: {
        chatMembers: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!existing?.chatMembers.map((cm) => cm.userId).includes(userId)) return;

    fetch(
      `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatTypingStatus}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, userId, isTyping }),
      }
    ).catch();
  } catch {}
};
