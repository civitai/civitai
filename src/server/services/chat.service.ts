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
import { DEFAULT_CHAT_SETTINGS, resolveDmPolicy } from '~/server/schema/chat.schema';
import { latestChat, singleChatSelect } from '~/server/selectors/chat.selector';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';
import { getUserSettings } from '~/server/services/user.service';
import { withSignals } from '~/server/signals/wrapper';
import { decideDmRouting, getChatHash } from '~/server/utils/chat';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  throwOnBlockedLinkDomain,
  throwOnBlockedMessagePattern,
} from '~/server/services/blocklist.service';
import { getOwnedStickerCosmetics } from '~/server/services/cosmetic.service';
import { createLimiter } from '~/server/utils/rate-limiting';
import { resolveStickerTokens, stripStickerTokens } from '~/shared/utils/sticker-token';
import { ChatMemberStatus, ChatMessageType, UserEngagementType } from '~/shared/utils/prisma/enums';
import type { ChatAllMessages, ChatCreateChat } from '~/types/router';

export const maxChats = 1000;
export const maxChatsPerDay = 10;
export const maxUsersPerChat = 10;

// Message rate limiting — stricter for new accounts (< 7 days old)
const newAccountAgeDays = 7;
const newAccountMessageLimit = 20; // per hour
const normalMessageLimit = 100; // per hour

const messageLimiter = createLimiter({
  counterKey: REDIS_SYS_KEYS.COUNTERS.CHAT_MESSAGES,
  limitKey: REDIS_SYS_KEYS.LIMITS.CHAT_MESSAGES,
  fetchCount: async () => 0,
  refetchInterval: 60 * 60, // 1 hour window
});

/**
 * Split recipients by `decideDmRouting`: `refused` are dropped from the chat
 * entirely, `filtered` join it but land in Requests.
 */
const evaluateDmPolicies = async ({
  userId,
  recipientIds,
}: {
  userId: number;
  recipientIds: number[];
}) => {
  const refused = new Set<number>();
  const filtered = new Set<number>();
  if (!recipientIds.length) return { refused, filtered };

  const [recipientSettings, sender, follows] = await Promise.all([
    Promise.all(recipientIds.map((id) => getUserSettings(id))),
    dbRead.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
    dbRead.userEngagement.findMany({
      where: {
        type: UserEngagementType.Follow,
        OR: [
          { userId: { in: recipientIds }, targetUserId: userId },
          { userId, targetUserId: { in: recipientIds } },
        ],
      },
      select: { userId: true, targetUserId: true },
    }),
  ]);

  const followsSender = new Set(
    follows.filter((f) => f.targetUserId === userId).map((f) => f.userId)
  );
  const followedBySender = new Set(
    follows.filter((f) => f.userId === userId).map((f) => f.targetUserId)
  );
  const senderIsNew = !!sender && dayjs().diff(dayjs(sender.createdAt), 'day') < newAccountAgeDays;

  recipientIds.forEach((recipientId, i) => {
    const settings = recipientSettings[i] ?? {};
    const routing = decideDmRouting({
      policy: resolveDmPolicy(settings),
      holdNewAccounts:
        settings.chat?.holdNewAccounts ?? DEFAULT_CHAT_SETTINGS.holdNewAccounts ?? true,
      senderIsNew,
      recipientFollowsSender: followsSender.has(recipientId),
      senderFollowsRecipient: followedBySender.has(recipientId),
    });

    if (routing === 'refuse') refused.add(recipientId);
    else if (routing === 'filter') filtered.add(recipientId);
  });

  return { refused, filtered };
};

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

  // Apply each recipient's DM policy (mods bypass). Only `nobody` refuses; a
  // sender who fails a `following`/`mutuals` policy still gets a chat, it just
  // lands in the recipient's Requests instead of their inbox.
  let filteredIds = new Set<number>();
  if (!isModerator) {
    const { refused, filtered } = await evaluateDmPolicies({
      userId,
      recipientIds: userIds.filter((u) => u !== userId),
    });
    if (refused.size) userIds = userIds.filter((u) => !refused.has(u));
    filteredIds = filtered;
  }

  // `userIds` includes the creator; everyone else is a recipient. If every
  // requested recipient was dropped (blocked, or not accepting chat), there is
  // no one to talk to — surface a friendly error instead of silently creating
  // a chat that only contains the creator.
  const remainingRecipients = userIds.filter((u) => u !== userId);
  if (remainingRecipients.length === 0) {
    throw throwBadRequestError('This user is not accepting chat requests');
  }

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
        filteredAt: filteredIds.has(u) ? newChat.createdAt : undefined,
      })),
    });

    return newChat;
  });

  if (isModerator) {
    for (const cmId of userIds) {
      withSignals(() =>
        fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/groups`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(`chat:${createdChat.id}`),
        })
      ).catch(() => undefined);
    }
  } else {
    // - add self to group
    withSignals(() =>
      fetch(`${env.SIGNALS_ENDPOINT}/users/${userId}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(`chat:${createdChat.id}`),
      })
    ).catch(() => undefined);
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
    withSignals(() =>
      fetch(
        `${env.SIGNALS_ENDPOINT}/groups/chat:${insertedChat.id}/signals/${SignalMessages.ChatNewRoom}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insertedChat as ChatCreateChat),
        }
      )
    ).catch(() => undefined);
  } else {
    // - sending new chat room signal without being part of the group
    for (const cmId of userIds) {
      withSignals(() =>
        fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/signals/${SignalMessages.ChatNewRoom}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insertedChat as ChatCreateChat),
        })
      ).catch(() => undefined);
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

  // The client's `:slug:` resolution is optimistic; this is the authority.
  if (userId !== -1) {
    const owned = await getOwnedStickerCosmetics(userId);
    const ownedIds = new Set(owned.map((x) => x.id));
    const ownedBySlug = new Map<string, number>();
    for (const sticker of owned)
      if (!ownedBySlug.has(sticker.slug)) ownedBySlug.set(sticker.slug, sticker.id);

    content = resolveStickerTokens(content, {
      resolveSlug: (slug) => ownedBySlug.get(slug),
      isOwnedId: (id) => ownedIds.has(id),
    }).trim();

    if (!content.length) {
      throw throwBadRequestError('Message cannot be empty');
    }
  }

  // Enforce blocklists and rate limits on message content
  if (userId !== -1 && !isModerator) {
    // Sticker tokens are stripped, not split around: `fu:sticker:1:ck` must still read as one word.
    const scannableContent = stripStickerTokens(content);
    await throwOnBlockedLinkDomain(scannableContent);
    await throwOnBlockedMessagePattern(scannableContent);

    // Rate limit messages — stricter for new accounts
    const user = await dbRead.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    const accountAgeDays = user ? dayjs().diff(dayjs(user.createdAt), 'day') : Infinity;
    const limit = accountAgeDays < newAccountAgeDays ? newAccountMessageLimit : normalMessageLimit;
    const count = await messageLimiter.increment(userId.toString());
    if (count > limit) {
      throw throwBadRequestError('You are sending messages too quickly. Please try again later.');
    }
  }

  const resp = await dbWrite.chatMessage.create({
    data: { chatId, contentType, content, referenceMessageId, userId },
  });

  withSignals(() =>
    fetch(
      `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatNewMessage}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resp as ChatAllMessages[number]),
      }
    )
  ).catch(() => undefined);

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
              withSignals(() =>
                fetch(
                  `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatNewMessage}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(embedResp as ChatAllMessages[number]),
                  }
                )
              ).catch(() => undefined);
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

              withSignals(() =>
                fetch(
                  `${env.SIGNALS_ENDPOINT}/groups/chat:${chatId}/signals/${SignalMessages.ChatNewMessage}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(embedResp as ChatAllMessages[number]),
                  }
                )
              ).catch(() => undefined);
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
