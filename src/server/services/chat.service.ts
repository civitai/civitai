import dayjs from '~/shared/utils/dayjs';
import { find as findLinks } from 'linkifyjs';
import { unfurl } from 'unfurl.js';
import { linkifyOptions } from '~/components/Chat/util';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { CreateChatInput, CreateMessageInput } from '~/server/schema/chat.schema';
import { latestChat, singleChatSelect } from '~/server/selectors/chat.selector';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';
import { getChatHash } from '~/server/utils/chat';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { ChatMemberStatus, ChatMessageType } from '~/shared/utils/prisma/enums';
import type { ChatAllMessages, ChatCreateChat } from '~/types/router';

export const maxChats = 1000;
export const maxChatsPerDay = 10;
export const maxUsersPerChat = 10;

export const upsertChat = async ({
  userIds,
  isModerator,
  isSupporter,
  userId,
}: CreateChatInput & { userId: number; isModerator?: boolean; isSupporter?: boolean }) => {
  const hash = getChatHash(userIds);
  // filter out blocked users from userIds
  const blockedUsers = await Promise.all([
    BlockedUsers.getCached({ userId }),
    BlockedByUsers.getCached({ userId }),
  ]);
  const blockedUserIds = [...new Set(blockedUsers.flat().map((u) => u.id))];
  userIds = userIds.filter((u) => !blockedUserIds.includes(u));

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
    where: { id: { in: userIds } },
  });

  if (usersExist !== userIds.length) {
    // could probably tell them which users here
    throw throwBadRequestError(
      `Some requested users do not exist (${usersExist}/${userIds.length})`
    );
  }

  const createdChat = await dbWrite.$transaction(async (tx) => {
    const newChat = await tx.chat.create({
      data: { hash, ownerId: userId },
      select: { id: true, createdAt: true },
    });

    await tx.chatMember.createMany({
      data: userIds.map((u) => ({
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
    for (const cmId of userIds) {
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
    for (const cmId of userIds) {
      fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/signals/${SignalMessages.ChatNewRoom}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(insertedChat as ChatCreateChat),
      }).catch();
    }
  }

  return insertedChat;
};

/**
 * Create a message (direct)
 */
export const createMessage = async ({
  userId,
  muted,
  isModerator,
  chatId,
  content,
  contentType,
  referenceMessageId,
}: CreateMessageInput & {
  userId: number;
  muted?: boolean;
  isModerator?: boolean;
}) => {
  const chat = await dbWrite.chat.findFirst({
    where: {
      id: chatId,
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
    throw throwBadRequestError(`Could not find chat with id: (${chatId})`);
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

    // let moderators chat with users who blocked them, otherwise check if every member blocked the user and prevent the message
    if (!isModerator) {
      const otherMembers = chat.chatMembers.filter((cm) => cm.userId !== userId);
      const blockedUsers = await Promise.all([
        BlockedUsers.getCached({ userId }),
        BlockedByUsers.getCached({ userId }),
      ]);
      const blockedUserIds = [...new Set(blockedUsers.flat().map((u) => u.id))];
      const blockedByAll = otherMembers.every((cm) => blockedUserIds.includes(cm.userId));
      if (blockedByAll) {
        throw throwBadRequestError(`Unable to post in this chat`);
      }
    }
  }

  if (referenceMessageId) {
    const existingReference = await dbWrite.chatMessage.count({
      where: { id: referenceMessageId },
    });
    if (existingReference === 0) {
      throw throwBadRequestError(`Reference message does not exist: (${referenceMessageId})`);
    }
  }

  const resp = await dbWrite.chatMessage.create({
    data: { chatId, contentType, content, referenceMessageId, userId },
  });

  fetch(`${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatNewMessage}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resp as ChatAllMessages[number]),
  }).catch();

  if (userId !== -1) {
    const links = findLinks(content, linkifyOptions);
    for (let { href } of links) {
      if (!href) continue;
      try {
        const airMatch = href.match(constants.chat.airRegex);
        if (airMatch && airMatch.groups) {
          const { mId, mvId } = airMatch.groups;
          href = `${env.NEXTAUTH_URL}/models/${mId}?modelVersionId=${mvId}`;
        }

        if (/^(?:https?:\/\/)?image./.test(href)) {
          dbWrite.chatMessage
            .create({
              data: {
                chatId: chatId,
                content: JSON.stringify({ image: href, href }),
                contentType: ChatMessageType.Embed,
                userId: -1,
                referenceMessageId: resp.id,
              },
            })
            .then((embedResp) => {
              fetch(
                `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatNewMessage}`,
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
                  chatId,
                  content: embedMsg,
                  contentType: ChatMessageType.Embed,
                  userId: -1,
                  referenceMessageId: resp.id,
                },
              });

              fetch(
                `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatNewMessage}`,
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
