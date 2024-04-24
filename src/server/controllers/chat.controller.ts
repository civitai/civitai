import { ChatMemberStatus, ChatMessageType, Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import dayjs from 'dayjs';
import { find as findLinks } from 'linkifyjs';
import { uniq } from 'lodash-es';
import { unfurl } from 'unfurl.js';
import { airRegex, linkifyOptions } from '~/components/Chat/ExistingChat';
import { env } from '~/env/server.mjs';
import { SignalMessages } from '~/server/common/enums';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  AddUsersInput,
  CreateChatInput,
  CreateMessageInput,
  GetInfiniteMessagesInput,
  GetMessageByIdInput,
  IsTypingInput,
  isTypingOutput,
  ModifyUserInput,
  UpdateMessageInput,
  UserSettingsChat,
} from '~/server/schema/chat.schema';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ChatAllMessages, ChatCreateChat } from '~/types/router';

const maxChats = 200;
const maxChatsPerDay = 10;
const maxUsersPerChat = 10;

const singleChatSelect = {
  id: true,
  createdAt: true,
  hash: true,
  ownerId: true,
  chatMembers: {
    // where: { status: { in: [ChatMemberStatus.Joined, ChatMemberStatus.Invited] } },
    select: {
      id: true,
      userId: true,
      isOwner: true,
      isMuted: true,
      status: true,
      lastViewedMessageId: true,
      createdAt: true,
      // TODO do we need these datetimes in the frontend?
      // joinedAt: true,
      // leftAt: true,
      // kickedAt: true,
      // unkickedAt: true,
      user: {
        select: {
          ...userWithCosmeticsSelect,
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
    },
  },
};

const latestChat = {
  messages: {
    orderBy: { createdAt: Prisma.SortOrder.desc },
    take: 1,
    select: {
      createdAt: true,
      content: true,
      contentType: true,
    },
    where: {
      contentType: { not: ChatMessageType.Embed },
    },
  },
};

/**
 * Get user chat settings
 */
export const getUserSettingsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id: userId } = ctx.user;
    const { chat = {} } = await getUserSettings(userId);
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
  ctx: DeepNonNullable<Context>;
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
export const getChatsForUserHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
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
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    const unread = await dbWrite.$queryRaw<{ chatId: number; cnt: number }[]>`
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

    const pending = await dbWrite.$queryRaw<{ chatId: number; cnt: number }[]>`
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
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

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

    dedupedUserIds.sort((a, b) => a - b);
    const hash = dedupedUserIds.join('-');

    const existing = await dbWrite.chat.findFirst({
      where: { hash },
      select: {
        ...singleChatSelect,
        ...latestChat,
      },
      // select: { id: true },
    });

    if (!!existing) {
      return existing;
    }

    const modInfo = await dbRead.user.findFirst({
      where: { id: userId },
      select: {
        isModerator: true,
        subscriptionId: true,
      },
    });
    const isModerator = modInfo?.isModerator === true;
    const isSupporter = !!modInfo?.subscriptionId; // TODO add check for CustomerSubscription = active/trialing
    const canBypassLimits = isModerator || isSupporter;

    const totalForUser = await dbWrite.chat.count({
      where: { ownerId: userId },
    });

    if (totalForUser >= maxChats && !canBypassLimits) {
      throw throwBadRequestError(`Cannot have more than ${maxChats} chats`);
    }

    // - limit chats per day, resetting at beginning of each day (not rolling)
    const totalTodayForUser = await dbWrite.chat.count({
      where: { ownerId: userId, createdAt: { gte: dayjs().startOf('date').toDate() } },
    });

    if (totalTodayForUser >= maxChatsPerDay && !canBypassLimits) {
      throw throwBadRequestError(`Cannot create more than ${maxChatsPerDay} chats per day`);
    }

    const usersExist = await dbRead.user.count({
      where: { id: { in: dedupedUserIds } },
    });

    if (usersExist !== dedupedUserIds.length) {
      // could probably tell them which users here
      throw throwBadRequestError(
        `Some requested users do not exist (${usersExist}/${dedupedUserIds.length})`
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
          status: u === userId || isModerator ? ChatMemberStatus.Joined : ChatMemberStatus.Invited,
          joinedAt: u === userId || isModerator ? newChat.createdAt : undefined,
        })),
      });

      return newChat;
    });

    if (isModerator) {
      for (const cmId of dedupedUserIds) {
        fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/groups`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(`chat:${createdChat.id}`),
        }).catch();
      }
    } else {
      // - add self to group
      fetch(`${env.SIGNALS_ENDPOINT}/users/${userId}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(`chat:${createdChat.id}`),
      }).catch();
    }

    // I don't like the idea of querying after an insert, but it's just easier than merging all the data together
    const insertedChat = await dbWrite.chat.findFirst({
      where: {
        id: createdChat.id,
      },
      select: {
        ...singleChatSelect,
        ...latestChat,
      },
    });
    if (!insertedChat) {
      throw throwBadRequestError('Chat creation failed.');
    }

    if (isModerator) {
      fetch(
        `${env.SIGNALS_ENDPOINT}/groups/chat:${insertedChat.id}/signals/${SignalMessages.ChatNewRoom}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insertedChat as ChatCreateChat),
        }
      ).catch();
    } else {
      // - sending new chat room signal without being part of the group
      for (const cmId of dedupedUserIds) {
        fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/signals/${SignalMessages.ChatNewRoom}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insertedChat as ChatCreateChat),
        }).catch();
      }
    }

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
      fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/signals/${SignalMessages.ChatNewRoom}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(insertedChat as ChatCreateChat),
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
      await fetch(`${env.SIGNALS_ENDPOINT}/users/${existing.userId}/groups`, {
        method: status === ChatMemberStatus.Joined ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(`chat:${existing.chat.id}`),
      });

      if (status !== ChatMemberStatus.Ignored) {
        await createMessageFn({
          input: {
            chatId: existing.chat.id,
            contentType: ChatMessageType.Markdown,
            content: `${existing.user.username} ${
              status === ChatMemberStatus.Joined
                ? 'joined'
                : status === ChatMemberStatus.Left
                ? 'left'
                : 'was kicked'
            }`,
          },
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
export const markAllAsReadHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
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
      orderBy: [{ id: input.direction }],
    });

    let nextCursor: number | undefined;

    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    if (input.direction === 'desc') {
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
  ctx: DeepNonNullable<Context>;
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
 * Create a message (direct)
 */
export const createMessageFn = async ({
  input,
  userId,
  muted,
}: {
  input: CreateMessageInput;
  userId: number;
  muted?: boolean;
}) => {
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
          isOwner: true,
          user: {
            select: {
              isModerator: true,
            },
          },
        },
      },
    },
  });

  if (!chat) {
    throw throwBadRequestError(`Could not find chat with id: (${input.chatId})`);
  }

  if (userId !== -1) {
    const thisMember = chat.chatMembers.find((cm) => cm.userId === userId);
    if (!thisMember) {
      throw throwBadRequestError(`Not a member of this chat`);
    }
    if (!['Invited', 'Joined'].includes(thisMember.status)) {
      throw throwBadRequestError(`Unable to post in this chat`);
    }

    if (muted) {
      const owner = chat.chatMembers.find((cm) => cm.isOwner === true);
      const isModeratorChat = owner?.user?.isModerator === true;
      if (!isModeratorChat) {
        throw throwBadRequestError(`Unable to post in this chat`);
      }
    }
  }

  if (input.referenceMessageId) {
    const existingReference = await dbWrite.chatMessage.count({
      where: { id: input.referenceMessageId },
    });
    if (existingReference === 0) {
      throw throwBadRequestError(`Reference message does not exist: (${input.referenceMessageId})`);
    }
  }

  const resp = await dbWrite.chatMessage.create({
    data: { ...input, userId },
  });

  fetch(
    `${env.SIGNALS_ENDPOINT}/groups/chat:${input.chatId}/signals/${SignalMessages.ChatNewMessage}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resp as ChatAllMessages[number]),
    }
  ).catch();

  if (userId !== -1) {
    const links = findLinks(input.content, linkifyOptions);
    for (let { href } of links) {
      if (!href) continue;
      try {
        const airMatch = href.match(airRegex);
        if (airMatch && airMatch.groups) {
          const { mId, mvId } = airMatch.groups;
          href = `${env.NEXTAUTH_URL}/models/${mId}?modelVersionId=${mvId}`;
        }

        if (/^(?:https?:\/\/)?image./.test(href)) {
          dbWrite.chatMessage
            .create({
              data: {
                chatId: input.chatId,
                content: JSON.stringify({ image: href, href }),
                contentType: ChatMessageType.Embed,
                userId: -1,
                referenceMessageId: resp.id,
              },
            })
            .then((embedResp) => {
              fetch(
                `${env.SIGNALS_ENDPOINT}/groups/chat:${input.chatId}/signals/${SignalMessages.ChatNewMessage}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(embedResp as ChatAllMessages[number]),
                }
              ).catch();
            });
        } else {
          unfurl(href)
            .then(async (hrefData) => {
              const embedData = {
                title: hrefData.title ?? hrefData.open_graph?.title ?? null,
                description: hrefData.description ?? hrefData.open_graph?.description ?? null,
                image: hrefData.open_graph?.images?.[0]?.url ?? hrefData.favicon ?? null,
                href,
              };
              const embedMsg = JSON.stringify(embedData);

              const embedResp = await dbWrite.chatMessage.create({
                data: {
                  chatId: input.chatId,
                  content: embedMsg,
                  contentType: ChatMessageType.Embed,
                  userId: -1,
                  referenceMessageId: resp.id,
                },
              });

              fetch(
                `${env.SIGNALS_ENDPOINT}/groups/chat:${input.chatId}/signals/${SignalMessages.ChatNewMessage}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(embedResp as ChatAllMessages[number]),
                }
              ).catch();
            })
            .catch();
        }
      } catch (e: unknown) {
        logToAxiom(
          {
            name: (e as Error)?.name,
            message: (e as Error)?.message,
            stack: (e as Error)?.stack,
            path: 'chat.createChat',
            user: userId,
          },
          'civitai-prod'
        ).catch();
      }
    }
  }

  return resp;
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
    const { id: userId, muted } = ctx.user;
    return await createMessageFn({ input, userId, muted });
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
    ).catch();
  } catch {
    // explicitly not reporting errors here, as it's just a transient signal
  }
};
