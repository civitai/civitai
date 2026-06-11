import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { uniq } from 'lodash-es';
import { env } from '~/env/server';
import { SignalMessages } from '~/server/common/enums';
import type { ProtectedContext } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  AddUsersInput,
  CreateChatInput,
  CreateMessageInput,
  GetInfiniteMessagesInput,
  GetMessageByIdInput,
  IsTypingInput,
  isTypingOutput,
  MarkChatReadInput,
  ModifyUserInput,
  UpdateMessageInput,
  UserSettingsChat,
} from '~/server/schema/chat.schema';
import { latestChat, singleChatSelect } from '~/server/selectors/chat.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { createMessage, maxUsersPerChat, upsertChat } from '~/server/services/chat.service';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';
import { withSignals } from '~/server/signals/wrapper';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ChatMemberStatus, ChatMessageType } from '~/shared/utils/prisma/enums';
import type { ChatCreateChat } from '~/types/router';

/**
 * Get user chat settings
 */
export const getUserSettingsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { id: userId } = ctx.user;
    const { chat = { muteSounds: false, replaceBadWords: false, acknowledged: false } } =
      await getUserSettings(userId);

    return chat;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Set user chat settings
 */
export const setUserSettingsHandler = async ({
  input,
  ctx,
}: {
  input: UserSettingsChat;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { chat = {} } = await getUserSettings(userId);
    const newChat = { ...chat, ...input };

    await setUserSetting(userId, { chat: newChat });

    return newChat;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Get all chats for a single user
 */
export const getChatsForUserHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { id: userId } = ctx.user;

    return await dbWrite.chat.findMany({
      where: {
        chatMembers: {
          some: { userId },
        },
      },
      orderBy: { createdAt: Prisma.SortOrder.desc },
      select: {
        ...singleChatSelect,
        ...latestChat,
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Get number of unread messages for user
 */
export const getUnreadMessagesForUserHandler = async ({
  // input,
  ctx,
}: {
  // input: GetUnreadInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;

    const unread = await dbRead.$queryRaw<{ chatId: number; cnt: number }[]>`
      select memb."chatId"          as "chatId",
             count(msg.id)::integer as "cnt"
      from "ChatMember" memb
             left join "ChatMessage" msg
                       on msg."chatId" = memb."chatId" and
                          (msg.id > memb."lastViewedMessageId" or
                           memb."lastViewedMessageId" is null
                            )
      where memb."userId" = ${userId}
        and memb.status = 'Joined'
        and memb."isMuted" is false
        and msg."userId" != ${userId}
      group by memb."chatId"
    `;

    const pending = await dbRead.$queryRaw<{ chatId: number; cnt: number }[]>`
      select memb."chatId" as "chatId",
             1             as "cnt"
      from "ChatMember" memb
      where memb."userId" = ${userId}
        and memb.status = 'Invited'
        and memb."isMuted" is false
      group by memb."chatId"
    `;

    return [...unread, ...pending];
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
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId, bannedAt } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');

    const dedupedUserIds = uniq(input.userIds);
    if (dedupedUserIds.length < 2) {
      throw throwBadRequestError('Must choose at least 1 user');
    }
    if (dedupedUserIds.length > maxUsersPerChat) {
      throw throwBadRequestError(`Must choose fewer than ${maxUsersPerChat} users`);
    }
    if (!dedupedUserIds.includes(userId)) {
      throw throwBadRequestError('Creator must be in the chat');
    }

    // const modInfo = await dbRead.user.findFirst({
    //   where: { id: userId },
    //   select: {
    //     isModerator: true,
    //     subscriptionId: true,
    //   },
    // });

    // TODO add check for CustomerSubscription = active/trialing
    const isModerator = ctx.user.isModerator;
    const isSupporter = !!ctx.user.tier;

    const chat = await upsertChat({
      userId,
      userIds: dedupedUserIds,
      isModerator,
      isSupporter,
    });

    return chat;
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
  ctx: ProtectedContext;
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
    let usersToAdd = dedupedUserIds.filter((uid) => !existingChatMemberIds.includes(uid));

    // don't pull users who have disabled chat into a chat (mods bypass)
    if (!ctx.user.isModerator && usersToAdd.length) {
      const settings = await Promise.all(usersToAdd.map((id) => getUserSettings(id)));
      usersToAdd = usersToAdd.filter((_, i) => settings[i]?.features?.chat !== false);
      if (!usersToAdd.length) {
        throw throwBadRequestError('The requested users are not accepting chat requests');
      }
    }

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
        `Some requested users do not exist (${usersExist}/${usersToAdd.length})`
      );
    }

    mergedUsers.sort((a, b) => a - b);
    const hash = mergedUsers.join('-');

    const insertedChat = await dbWrite.$transaction(async (tx) => {
      await tx.chatMember.createMany({
        data: usersToAdd.map((uta) => ({
          userId: uta,
          chatId: input.chatId,
          status: ChatMemberStatus.Invited,
        })),
      });
      return tx.chat.update({
        where: { id: input.chatId },
        data: { hash },
        select: {
          ...singleChatSelect,
          ...latestChat,
        },
      });
    });

    for (const cmId of usersToAdd) {
      withSignals(() =>
        fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/signals/${SignalMessages.ChatNewRoom}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insertedChat as ChatCreateChat),
        })
      ).catch(() => undefined);
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
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;

    const { chatMemberId, status, ...rest } = input;

    const definedValues = { status, ...rest };
    const definedValuesLength = Object.values(definedValues).filter(
      (val) => val !== undefined
    ).length;
    // we should only be setting exactly one variable at a time here
    if (definedValuesLength !== 1) {
      throw throwBadRequestError(`Too many fields being set.`);
    }

    const existing = await dbWrite.chatMember.findFirst({
      where: { id: chatMemberId },
      select: {
        userId: true,
        user: {
          select: {
            username: true,
            isModerator: true,
          },
        },
        chat: {
          select: {
            id: true,
            ownerId: true,
            owner: {
              select: {
                isModerator: true,
              },
            },
            chatMembers: {
              where: { isOwner: true },
              select: {
                status: true,
              },
            },
          },
        },
      },
    });

    if (!existing) {
      throw throwBadRequestError(`Could not find chat member`);
    }

    if (status === ChatMemberStatus.Kicked) {
      // I guess owners can kick themselves out :/
      if (existing.chat.ownerId !== userId) {
        throw throwBadRequestError(`Cannot modify users for a chat you are not the owner of`);
      }
    } else {
      if (userId !== existing.userId) {
        throw throwBadRequestError(`Cannot modify chat status for another user`);
      }
    }

    if (
      status === ChatMemberStatus.Left &&
      existing.chat.owner.isModerator &&
      existing.chat.chatMembers[0]?.status === ChatMemberStatus.Joined &&
      !existing.user.isModerator
    ) {
      throw throwBadRequestError(`Cannot leave a moderator chat while they are still present`);
    }

    // TODO if a moderator rejoins, auto-rejoin other users

    const extra = {
      joinedAt: status === ChatMemberStatus.Joined ? new Date() : undefined,
      ignoredAt: status === ChatMemberStatus.Ignored ? new Date() : undefined,
      leftAt: status === ChatMemberStatus.Left ? new Date() : undefined,
      kickedAt: status === ChatMemberStatus.Kicked ? new Date() : undefined,
    };

    const resp = await dbWrite.chatMember.update({
      where: { id: chatMemberId },
      data: { status, ...rest, ...extra },
    });

    if (!!status && status !== ChatMemberStatus.Invited) {
      // we want to await here to avoid race conditions
      await withSignals(() =>
        fetch(`${env.SIGNALS_ENDPOINT}/users/${existing.userId}/groups`, {
          method: status === ChatMemberStatus.Joined ? 'POST' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(`chat:${existing.chat.id}`), // * for all
        })
      );

      if (status !== ChatMemberStatus.Ignored) {
        await createMessage({
          chatId: existing.chat.id,
          contentType: ChatMessageType.Markdown,
          content: `${existing.user.username} ${
            status === ChatMemberStatus.Joined
              ? 'joined'
              : status === ChatMemberStatus.Left
              ? 'left'
              : 'was kicked'
          }`,
          userId: -1,
        });
      }
    }

    return resp;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Mark all messages as read for active chats
 */
export const markAllAsReadHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { id: userId } = ctx.user;

    return await dbWrite.$queryRaw<{ chatId: number; lastViewedMessageId: number }[]>`
      update "ChatMember"
      set "lastViewedMessageId" = data.last_msg
      from (select *
            from (select cm.id, cm."lastViewedMessageId" as last_viewed, max(msg.id) as last_msg
                  from "ChatMember" cm
                         join "ChatMessage" msg on cm."chatId" = msg."chatId"
                  where cm."userId" = ${userId}
                    and cm.status = 'Joined'
                  group by 1, 2) d
            where d.last_viewed is distinct from d.last_msg) as data
      where "ChatMember".id = data.id
      returning "chatId", "lastViewedMessageId"
    `;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Mark a single chat as read for the calling user. Resolves the caller's
 * chatMember + the chat's latest message id server-side, then advances
 * lastViewedMessageId. Gives per-chat read precision for headless/agent (MCP)
 * callers (the website only exposes blanket markAllAsRead).
 */
export const markChatReadHandler = async ({
  input,
  ctx,
}: {
  input: MarkChatReadInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { chatId } = input;

    const member = await dbWrite.chatMember.findFirst({
      where: { chatId, userId, status: ChatMemberStatus.Joined },
      select: { id: true, lastViewedMessageId: true },
    });
    if (!member) throw throwNotFoundError(`You are not a member of this chat`);

    const latestMessage = await dbWrite.chatMessage.findFirst({
      where: { chatId },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    // No messages yet, or already up to date — nothing to advance.
    if (!latestMessage || member.lastViewedMessageId === latestMessage.id) {
      return { chatId, lastViewedMessageId: member.lastViewedMessageId ?? null };
    }

    await dbWrite.chatMember.update({
      where: { id: member.id },
      data: { lastViewedMessageId: latestMessage.id },
    });

    return { chatId, lastViewedMessageId: latestMessage.id };
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
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;

    const chat = await dbWrite.chat.findFirst({
      where: { id: input.chatId },
      select: {
        chatMembers: {
          select: {
            userId: true,
            status: true,
            leftAt: true,
            kickedAt: true,
          },
        },
      },
    });

    if (!chat || !chat.chatMembers.map((cm) => cm.userId).includes(userId)) {
      throw throwNotFoundError(`No chat found for ID (${input.chatId})`);
    }

    const thisMember = chat.chatMembers.find((cm) => cm.userId === userId);
    const dateLimit: { createdAt?: { lt: Date } } = {};
    if (!thisMember) {
      dateLimit.createdAt = { lt: new Date(1970) };
    } else if (thisMember.status === ChatMemberStatus.Left) {
      dateLimit.createdAt = { lt: thisMember.leftAt ?? new Date(1970) };
    } else if (thisMember.status === ChatMemberStatus.Kicked) {
      dateLimit.createdAt = { lt: thisMember.kickedAt ?? new Date(1970) };
    } else if (thisMember.status === ChatMemberStatus.Ignored) {
      // TODO do we need ignoredAt?
      dateLimit.createdAt = { lt: new Date(1970) };
    }

    const items = await dbWrite.chatMessage.findMany({
      where: { chatId: input.chatId, ...dateLimit },
      take: input.limit + 1,
      cursor: input.cursor ? { id: input.cursor } : undefined,
      orderBy: [{ id: input.sortDirection }],
    });

    let nextCursor: number | undefined;

    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    if (input.sortDirection === 'desc') {
      items.reverse();
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
 * Get a single message
 */
export const getMessageByIdHandler = async ({
  input,
  ctx,
}: {
  input: GetMessageByIdInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;

    const msg = await dbWrite.chatMessage.findFirst({
      where: { id: input.messageId },
      select: {
        content: true,
        contentType: true,
        user: {
          select: {
            id: true,
            username: true,
            isModerator: true,
            deletedAt: true,
            image: true,
            profilePicture: {
              select: profileImageSelect,
            },
          },
        },
        chat: {
          select: {
            chatMembers: {
              select: {
                userId: true,
                status: true,
                leftAt: true,
                kickedAt: true,
              },
            },
          },
        },
      },
    });

    // TODO fix this and above to check for the user status too (by date)
    if (!msg || !msg.chat.chatMembers.map((cm) => cm.userId).includes(userId)) {
      throw throwNotFoundError(`No message found for ID (${input.messageId})`);
    }

    return {
      content: msg.content,
      contentType: msg.contentType,
      user: msg.user,
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
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId, muted, isModerator, bannedAt } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');

    return await createMessage({ ...input, userId, muted, isModerator });
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) => {
  try {
    if (!env.SIGNALS_ENDPOINT) throw throwInternalServerError(new Error('No signals endpoint'));

    const { id: userId, muted } = ctx.user;

    const { chatId, isTyping } = input;

    const existing = await dbWrite.chat.findFirst({
      where: { id: chatId },
      select: {
        chatMembers: {
          select: {
            userId: true,
            isOwner: true,
            user: {
              select: {
                username: true,
                isModerator: true,
              },
            },
          },
        },
      },
    });

    if (!existing) return;
    const existingUser = existing.chatMembers.find((cm) => cm.userId === userId);
    if (!existingUser) return;

    if (muted) {
      const owner = existing.chatMembers.find((cm) => cm.isOwner === true);
      const isModeratorChat = owner?.user?.isModerator === true;
      if (!isModeratorChat) {
        return;
      }
    }

    withSignals(() =>
      fetch(
        `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatTypingStatus}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            userId,
            isTyping,
            username: existingUser.user.username,
          } as isTypingOutput),
        }
      )
    ).catch(() => undefined);
  } catch {
    // explicitly not reporting errors here, as it's just a transient signal
  }
};
