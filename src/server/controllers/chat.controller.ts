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
  ClearChatInput,
  DeleteMessageInput,
  MarkChatReadInput,
  ModifyUserInput,
  UpdateChatInput,
  UpdateMessageInput,
  UserSettingsChat,
} from '~/server/schema/chat.schema';
import { resolveChatSettings } from '~/server/schema/chat.schema';
import { truncateAuditValue } from '~/server/common/chat-audit.constants';
import { deriveMuteColumns, scopeMemberPrivacy } from '~/shared/utils/chat';
import {
  throwOnBlockedLinkDomain,
  throwOnBlockedMessagePattern,
} from '~/server/services/blocklist.service';
import { stripStickerTokens } from '~/shared/utils/sticker-token';
import type { GetChatAuditInput, GetModeratorChatInput } from '~/server/schema/chat-audit.schema';
import { clickhouse } from '~/server/clickhouse/client';
import {
  chatReferenceMessageSelect,
  latestChat,
  singleChatSelect,
} from '~/server/selectors/chat.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';
import {
  assertChatNameAllowed,
  createMessage,
  maxUsersPerChat,
  resolveChatRecipients,
  signalChatMembersUpdated,
  upsertChat,
} from '~/server/services/chat.service';
import {
  assertCanPromote,
  assertGroupAdmin,
  assertRoomForMembers,
  isActiveMember,
  normalizeChatName,
  selectNextOwner,
} from '~/server/utils/chat-group';
import { getUserSettings, patchUserSettings } from '~/server/services/user.service';
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
import { isDefined } from '~/utils/type-guards';

export type ChatAuditEventRow = {
  createdAt: string;
  type: string;
  chatId: number;
  messageId: number;
  actorId: number;
  subjectId: number;
  actorRole: string;
  oldValue: string;
  newValue: string;
  truncated: number;
};

/**
 * The redesign is staged to moderators, and these two actions destroy a user's
 * view of their own history. Gating them in the client render branch alone left
 * them callable over the API by anyone, ahead of the review the staging exists
 * to buy.
 */
function assertChatRedesign(ctx: ProtectedContext) {
  if (!ctx.features.chatRedesign) throw throwAuthorizationError('This feature is not available');
}

/**
 * Per-member state that belongs to that member alone. Shipping another user's
 * copy tells a sender whether their message was filtered — an oracle on the
 * recipient's DM policy — and tells them the recipient deleted the thread.
 */

/**
 * Get user chat settings
 */
export const getUserSettingsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  try {
    const { id: userId } = ctx.user;
    const { chat } = await getUserSettings(userId);
    // Shared resolve helper guarantees the SSR seed (_app) and this resolver
    // produce byte-identical output when `chat` is absent (#2471).
    return resolveChatSettings(chat);
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
    // `features` is still READ, but only to decide whether to reopen — never to build
    // the value written. A stale read here is idempotent (setting `chat: true` when it
    // already is), never a lost write.
    const { features } = await getUserSettings(userId);

    // `features.chat === false` reads as `nobody` (resolveDmPolicy), so leaving it
    // set would silently override any policy chosen here and the picker would
    // appear to do nothing.
    const reopenChat = !!input.dmPolicy && input.dmPolicy !== 'nobody' && features?.chat === false;

    // Merged in Postgres, over the stored column — `settings->'chat'` is read inside the
    // UPDATE, so nothing about the object is carried through JS. This used to read the
    // blob via `getUserSettings` (Redis, 4h TTL), merge in JS and write the whole `chat`
    // object back, which REPLACED the key: every sub-key reverted to the snapshot and any
    // chat setting written in between was discarded. Reachable in ordinary use because the
    // sub-keys are written from different surfaces — `NewChat` writes `acknowledged` on
    // terms acceptance while `ChatList` writes `muteSounds`/`replaceBadWords` — so two
    // requests carrying disjoint keys is the normal case. See the getUserSettings contract.
    //
    // 🔴 The `features` reopen (#4119) goes through the SAME atomic merge. It arrived as
    // `{ ...features, chat: true }`, which rebuilds the whole `features` object from that
    // same 4h-TTL snapshot — the exact read-modify-write this change removes, one key
    // over, and it would have silently discarded any other `features.*` sub-key written
    // in between. `mergeInto` touches only `features.chat` and leaves every sibling
    // sub-key alone, so both writes in this handler are now atomic rather than one of
    // each.
    const settings = await patchUserSettings(userId, {
      mergeInto: {
        chat: input,
        ...(reopenChat ? { features: { chat: true } } : {}),
      },
      location: 'chat.controller:setUserSettings',
    });

    // Returned from `RETURNING settings`, so the client's query cache is primed with what
    // the database actually holds rather than with a merge computed off a stale snapshot.
    return (settings.chat ?? {}) as UserSettingsChat;
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

    const chats = await dbWrite.chat.findMany({
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

    // A deleted conversation is gone from this user's list until the other side
    // writes again, at which point it returns holding only what came after the
    // watermark. `latestChat` is a static selector and cannot be scoped per
    // member, so the preview is trimmed here instead.
    return chats
      .map((chat) => {
        const scoped = { ...chat, chatMembers: chat.chatMembers.map(scopeMemberPrivacy(userId)) };
        const clearedAt = scoped.chatMembers.find((cm) => cm.userId === userId)?.clearedAt;
        if (!clearedAt) return scoped;

        const messages = scoped.messages.filter((msg) => msg.createdAt > clearedAt);
        return messages.length ? { ...scoped, messages } : null;
      })
      .filter(isDefined);
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
                            ) and
                          (memb."clearedAt" is null or msg."createdAt" > memb."clearedAt") and
                          msg."deletedAt" is null
      where memb."userId" = ${userId}
        and memb.status = 'Joined'
        and memb."notifyLevel" <> 'None'
        and memb."filteredAt" is null
        and msg."userId" != ${userId}
      group by memb."chatId"
    `;

    // Requests (filteredAt set) are deliberately absent: a filtered request that
    // still lights the header badge is not filtered.
    const pending = await dbRead.$queryRaw<{ chatId: number; cnt: number }[]>`
      select memb."chatId" as "chatId",
             1             as "cnt"
      from "ChatMember" memb
      where memb."userId" = ${userId}
        and memb.status = 'Invited'
        and memb."notifyLevel" <> 'None'
        and memb."filteredAt" is null
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
      isGroup: input.isGroup,
      name: input.name,
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
 * Rename a group. Passing a blank name clears it, so the title falls back to the
 * member list.
 */
export const updateChatHandler = async ({
  input,
  ctx,
}: {
  input: UpdateChatInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId, bannedAt, isModerator } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');

    const existing = await dbWrite.chat.findFirst({
      where: { id: input.chatId },
      select: { id: true, isGroup: true, ownerId: true, name: true },
    });

    if (!existing) {
      throw throwNotFoundError(`Could not find chat with id: (${input.chatId})`);
    }

    assertGroupAdmin({ chat: existing, actorId: userId, isModerator });

    const name = normalizeChatName(input.name);
    await assertChatNameAllowed(name);

    const updated = await dbWrite.chat.update({
      where: { id: existing.id },
      data: { name },
      select: {
        ...singleChatSelect,
        ...latestChat,
      },
    });

    // Renaming to the name it already has should not announce itself.
    if (name === existing.name) return updated;

    withSignals(() =>
      fetch(
        `${env.SIGNALS_ENDPOINT}/groups/chat:${existing.id}/signals/${SignalMessages.ChatRoomUpdated}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: existing.id, name }),
        }
      )
    ).catch(() => undefined);

    await createMessage({
      chatId: existing.id,
      contentType: ChatMessageType.Markdown,
      content: name ? `Group renamed to "${name}"` : 'Group name removed',
      userId: -1,
    });

    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Add members to an existing group chat.
 */
export const addUsersHandler = async ({
  input,
  ctx,
}: {
  input: AddUsersInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId, bannedAt, isModerator } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');

    const existing = await dbWrite.chat.findFirst({
      where: { id: input.chatId },
      select: {
        id: true,
        isGroup: true,
        ownerId: true,
        chatMembers: {
          select: { id: true, userId: true, status: true },
        },
      },
    });

    if (!existing) {
      throw throwNotFoundError(`Could not find chat with id: (${input.chatId})`);
    }

    assertGroupAdmin({ chat: existing, actorId: userId, isModerator });

    const membersByUserId = new Map(existing.chatMembers.map((cm) => [cm.userId, cm]));
    const requested = uniq(input.userIds).filter((uid) => {
      const member = membersByUserId.get(uid);
      // A member who left or was removed can be invited back; one who is still
      // in the group is a no-op rather than an error.
      return !member || !isActiveMember(member);
    });

    if (!requested.length) {
      throw throwBadRequestError('Those users are already in this chat');
    }

    const { allowed, filteredIds } = await resolveChatRecipients({
      userId,
      recipientIds: requested,
      isModerator,
    });

    if (!allowed.length) {
      throw throwBadRequestError('The requested users are not accepting chat requests');
    }

    assertRoomForMembers({
      members: existing.chatMembers,
      adding: allowed.length,
      limit: maxUsersPerChat,
    });

    const users = await dbRead.user.findMany({
      where: { id: { in: allowed } },
      select: { id: true, username: true },
    });

    if (users.length !== allowed.length) {
      throw throwBadRequestError(
        `Some requested users do not exist (${users.length}/${allowed.length})`
      );
    }

    const toReinvite = allowed.map((uid) => membersByUserId.get(uid)).filter(isDefined);
    const toCreate = allowed.filter((uid) => !membersByUserId.has(uid));

    const insertedChat = await dbWrite.$transaction(async (tx) => {
      if (toCreate.length) {
        await tx.chatMember.createMany({
          data: toCreate.map((uid) => ({
            userId: uid,
            chatId: existing.id,
            status: ChatMemberStatus.Invited,
            filteredAt: filteredIds.has(uid) ? new Date() : undefined,
          })),
        });
      }
      for (const member of toReinvite) {
        await tx.chatMember.update({
          where: { id: member.id },
          data: {
            status: ChatMemberStatus.Invited,
            kickedAt: null,
            leftAt: null,
            ignoredAt: null,
            filteredAt: filteredIds.has(member.userId) ? new Date() : null,
          },
        });
      }
      return tx.chat.findFirstOrThrow({
        where: { id: existing.id },
        select: {
          ...singleChatSelect,
          ...latestChat,
        },
      });
    });

    for (const cmId of allowed) {
      withSignals(() =>
        fetch(`${env.SIGNALS_ENDPOINT}/users/${cmId}/signals/${SignalMessages.ChatNewRoom}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insertedChat as ChatCreateChat),
        })
      ).catch(() => undefined);
    }

    const addedNames = users.map((u) => u.username ?? `User ${u.id}`);
    await createMessage({
      chatId: existing.id,
      contentType: ChatMessageType.Markdown,
      content: `${addedNames.join(', ')} ${addedNames.length > 1 ? 'were' : 'was'} added`,
      userId: -1,
    });

    // Last, so the refetch it triggers already sees the note above. The invitees
    // are named because they only join the `chat:<id>` signals group on accept.
    await signalChatMembersUpdated({ chatId: existing.id, userIds: allowed });

    return insertedChat;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

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

    const { chatMemberId, status, isPinned, isMuted, notifyLevel, isOwner, ...rest } = input;

    const definedValues = { status, isPinned, isMuted, notifyLevel, isOwner, ...rest };
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
        id: true,
        userId: true,
        status: true,
        isOwner: true,
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
            isGroup: true,
            owner: {
              select: {
                isModerator: true,
              },
            },
            chatMembers: {
              select: {
                id: true,
                userId: true,
                isOwner: true,
                status: true,
                createdAt: true,
                joinedAt: true,
              },
            },
          },
        },
      },
    });

    if (!existing) {
      throw throwBadRequestError(`Could not find chat member`);
    }

    const ownerMember = existing.chat.chatMembers.find((cm) => cm.isOwner);

    if (isOwner) {
      assertCanPromote({
        chat: existing.chat,
        target: existing,
        actorId: userId,
        isModerator: ctx.user.isModerator,
      });
    } else if (status === ChatMemberStatus.Kicked) {
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
      ownerMember?.status === ChatMemberStatus.Joined &&
      !existing.user.isModerator
    ) {
      throw throwBadRequestError(`Cannot leave a moderator chat while they are still present`);
    }

    // Handing the group over is a two-row move, so it does not go through the
    // single-column update below.
    if (isOwner) {
      const [, promoted] = await dbWrite.$transaction([
        dbWrite.chatMember.updateMany({
          where: { chatId: existing.chat.id, isOwner: true },
          data: { isOwner: false },
        }),
        dbWrite.chatMember.update({ where: { id: chatMemberId }, data: { isOwner: true } }),
        dbWrite.chat.update({
          where: { id: existing.chat.id },
          data: { ownerId: existing.userId },
        }),
      ]);

      await createMessage({
        chatId: existing.chat.id,
        contentType: ChatMessageType.Markdown,
        content: `${existing.user.username} is now the group admin`,
        userId: -1,
      });

      await signalChatMembersUpdated({ chatId: existing.chat.id });

      return promoted;
    }

    // TODO if a moderator rejoins, auto-rejoin other users

    const extra = {
      joinedAt: status === ChatMemberStatus.Joined ? new Date() : undefined,
      ignoredAt: status === ChatMemberStatus.Ignored ? new Date() : undefined,
      leftAt: status === ChatMemberStatus.Left ? new Date() : undefined,
      kickedAt: status === ChatMemberStatus.Kicked ? new Date() : undefined,
      pinnedAt: isPinned === undefined ? undefined : isPinned ? new Date() : null,
      // Accepting is what ends a request; leaving the mark set would strand the
      // conversation in Requests forever.
      filteredAt: status === ChatMemberStatus.Joined ? null : undefined,
      ...deriveMuteColumns({ isMuted, notifyLevel }),
    };

    const resp = await dbWrite.chatMember.update({
      where: { id: chatMemberId },
      data: { status, ...rest, ...extra },
    });

    const statusChanged = !!status && status !== existing.status;

    // An owner who leaves takes the only account that can administer the group
    // with them, so the group is handed to the longest-joined member who stays.
    let successor: { userId: number; username: string | null } | undefined;
    if (
      statusChanged &&
      existing.chat.isGroup &&
      existing.isOwner &&
      (status === ChatMemberStatus.Left || status === ChatMemberStatus.Kicked)
    ) {
      const next = selectNextOwner(existing.chat.chatMembers, chatMemberId);
      if (next) {
        await dbWrite.$transaction([
          dbWrite.chatMember.update({ where: { id: chatMemberId }, data: { isOwner: false } }),
          dbWrite.chatMember.update({ where: { id: next.id }, data: { isOwner: true } }),
          dbWrite.chat.update({
            where: { id: existing.chat.id },
            data: { ownerId: next.userId },
          }),
        ]);
        const nextUser = await dbRead.user.findUnique({
          where: { id: next.userId },
          select: { username: true },
        });
        successor = { userId: next.userId, username: nextUser?.username ?? null };
      }
    }

    if (statusChanged && status !== ChatMemberStatus.Invited) {
      // Awaited to order the group change before the system message below, but
      // swallowed like every other emit here: the membership row is already
      // written, and letting an unreachable signals service throw reported the
      // action as failed after it had actually succeeded.
      await withSignals(() =>
        fetch(`${env.SIGNALS_ENDPOINT}/users/${existing.userId}/groups`, {
          method: status === ChatMemberStatus.Joined ? 'POST' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(`chat:${existing.chat.id}`), // * for all
        })
      ).catch(() => undefined);

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

    if (successor) {
      await createMessage({
        chatId: existing.chat.id,
        contentType: ChatMessageType.Markdown,
        content: `${successor.username ?? `User ${successor.userId}`} is now the group admin`,
        userId: -1,
      });
    }

    // Emitted once, after every system note above, so a recipient's refetch sees
    // the finished state. The member themselves is named because a leave or a
    // kick already took them out of the `chat:<id>` signals group, and the
    // broadcast alone would skip the one person who most needs to know.
    if (statusChanged || successor) {
      await signalChatMembersUpdated({ chatId: existing.chat.id, userIds: [existing.userId] });
    }

    return resp;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Delete a conversation, for the caller only.
 *
 * Stamps `clearedAt` on their own member row rather than deleting rows. Their
 * read paths hide everything at or before the watermark, so the next chat with
 * this person opens empty — but the messages stay resolvable, which is what
 * keeps a `ChatReport` filed against the thread reviewable after either
 * participant clears their side.
 */
export const clearChatHandler = async ({
  input,
  ctx,
}: {
  input: ClearChatInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId, bannedAt } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');
    assertChatRedesign(ctx);
    const { chatId } = input;

    const member = await dbWrite.chatMember.findFirst({
      where: { chatId, userId },
      select: { id: true },
    });

    if (!member) {
      throw throwNotFoundError(`No chat found for ID (${chatId})`);
    }

    const latestMessage = await dbWrite.chatMessage.findFirst({
      where: { chatId },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    const clearedAt = new Date();

    // Advancing lastViewedMessageId alongside the watermark keeps the unread
    // count from surviving a delete: everything behind it is now unreachable.
    await dbWrite.chatMember.update({
      where: { id: member.id },
      data: { clearedAt, lastViewedMessageId: latestMessage?.id },
    });

    await ctx.track
      .chatAudit({
        type: 'clear',
        chatId,
        actorId: userId,
        subjectId: userId,
        actorRole: 'owner',
        oldValue: '',
        newValue: '',
        truncated: 0,
      })
      .catch(() => undefined);

    return { chatId, clearedAt };
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
    const { id: userId, bannedAt } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');
    assertChatRedesign(ctx);
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
            clearedAt: true,
          },
        },
      },
    });

    if (!chat || !chat.chatMembers.map((cm) => cm.userId).includes(userId)) {
      throw throwNotFoundError(`No chat found for ID (${input.chatId})`);
    }

    const thisMember = chat.chatMembers.find((cm) => cm.userId === userId);
    const createdAt: { lt?: Date; gt?: Date } = {};
    if (!thisMember) {
      createdAt.lt = new Date(1970);
    } else if (thisMember.status === ChatMemberStatus.Left) {
      createdAt.lt = thisMember.leftAt ?? new Date(1970);
    } else if (thisMember.status === ChatMemberStatus.Kicked) {
      createdAt.lt = thisMember.kickedAt ?? new Date(1970);
    } else if (thisMember.status === ChatMemberStatus.Ignored) {
      // TODO do we need ignoredAt?
      createdAt.lt = new Date(1970);
    }
    // Deleted-conversation watermark. Combines with the status limits above
    // rather than replacing them — a member who cleared and later left is bounded
    // on both ends.
    if (thisMember?.clearedAt) createdAt.gt = thisMember.clearedAt;

    const dateLimit = Object.keys(createdAt).length ? { createdAt } : {};

    const items = await dbWrite.chatMessage.findMany({
      where: { chatId: input.chatId, deletedAt: null, ...dateLimit },
      take: input.limit + 1,
      cursor: input.cursor ? { id: input.cursor } : undefined,
      orderBy: [{ id: input.sortDirection }],
      // Reply quotes ride along. Resolving them client-side cost one
      // getMessageById per quoted message, and a page holds up to `limit` of them.
      include: { referenceMessage: { select: chatReferenceMessageSelect } },
    });

    // A stored `referenceMessageId` is only as trustworthy as the check in force
    // when it was written, and a quote must not resurrect what the reader is not
    // entitled to: another chat's message, a deleted one, or anything behind
    // their own clear watermark.
    const visibleItems = items.map((item) =>
      item.referenceMessage &&
      (item.referenceMessage.chatId !== input.chatId ||
        !!item.referenceMessage.deletedAt ||
        (!!thisMember?.clearedAt && item.referenceMessage.createdAt <= thisMember.clearedAt))
        ? { ...item, referenceMessage: null }
        : item
    );
    items.length = 0;
    items.push(...visibleItems);

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
      where: { id: input.messageId, deletedAt: null },
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
 * Edit a message. Authors edit their own; moderators edit anyone's.
 *
 * Either way the pre-edit content goes to the audit log first, so a message
 * rewritten after a report was filed still resolves to what it said when it was
 * reported.
 *
 * Content passes the same blocklist scans `createMessage` applies — the previous
 * incarnation of this handler wrote `content` through unchecked, which is why it
 * was never routed.
 */
export const updateMessageHandler = async ({
  input,
  ctx,
}: {
  input: UpdateMessageInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { messageId, content } = input;
    const { id: userId, isModerator, muted, bannedAt } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');
    assertChatRedesign(ctx);

    const existing = await dbWrite.chatMessage.findFirst({
      where: { id: messageId },
      select: { id: true, chatId: true, userId: true, content: true, deletedAt: true },
    });

    const isOwn = existing?.userId === userId;
    if (!existing || (!isOwn && !isModerator)) {
      throw throwNotFoundError(`No message found for ID (${messageId})`);
    }
    // An edit writes content, so it answers to the same restriction sending does.
    if (muted && !isModerator) {
      throw throwAuthorizationError('You cannot edit messages while restricted');
    }
    if (existing.userId === -1) {
      throw throwBadRequestError('System messages cannot be edited');
    }
    if (existing.deletedAt) throw throwBadRequestError('Deleted messages cannot be edited');

    const trimmed = content.trim();
    if (!trimmed.length) throw throwBadRequestError('Message cannot be empty');

    // Sticker tokens are stripped, not split around, so `fu:sticker:1:ck` still
    // reads as one word to the scanner.
    const scannable = stripStickerTokens(trimmed);
    await throwOnBlockedLinkDomain(scannable);
    await throwOnBlockedMessagePattern(scannable);

    const editedAt = new Date();
    await dbWrite.chatMessage.update({
      where: { id: existing.id },
      data: { content: trimmed, editedAt },
    });

    const before = truncateAuditValue(existing.content);
    const after = truncateAuditValue(trimmed);
    await ctx.track
      .chatAudit({
        type: 'edit',
        chatId: existing.chatId,
        messageId: existing.id,
        actorId: userId,
        subjectId: existing.userId,
        actorRole: isOwn ? 'owner' : 'moderator',
        oldValue: before.value,
        newValue: after.value,
        truncated: before.truncated || after.truncated,
      })
      .catch(() => undefined);

    // Both participants are still rendering the old text until told otherwise.
    withSignals(() =>
      fetch(
        `${env.SIGNALS_ENDPOINT}/groups/chat:${existing.chatId}/signals/${SignalMessages.ChatMessageUpdated}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: existing.id,
            chatId: existing.chatId,
            content: trimmed,
            editedAt,
          }),
        }
      )
    ).catch(() => undefined);

    return { messageId: existing.id, chatId: existing.chatId, content: trimmed };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Delete a message.
 *
 * Hides it from everyone in the chat and retains the row: the delete is
 * recorded, so a report filed against the thread afterwards still resolves to
 * what was actually said. Authors delete their own; moderators delete anyone's.
 */
export const deleteMessageHandler = async ({
  input,
  ctx,
}: {
  input: DeleteMessageInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId, isModerator, bannedAt } = ctx.user;
    if (bannedAt) throw throwAuthorizationError('You are banned from performing this action');
    assertChatRedesign(ctx);

    const existing = await dbWrite.chatMessage.findFirst({
      where: { id: input.messageId },
      select: { id: true, userId: true, chatId: true, content: true, deletedAt: true },
    });

    if (!existing || (existing.userId !== userId && !isModerator)) {
      throw throwNotFoundError(`No message found for ID (${input.messageId})`);
    }
    if (existing.deletedAt) return { messageId: existing.id, chatId: existing.chatId };

    const deletedAt = new Date();
    await dbWrite.chatMessage.update({
      where: { id: existing.id },
      data: { deletedAt },
    });

    const { value, truncated } = truncateAuditValue(existing.content);
    await ctx.track
      .chatAudit({
        type: 'delete',
        chatId: existing.chatId,
        messageId: existing.id,
        actorId: userId,
        subjectId: existing.userId,
        actorRole: existing.userId === userId ? 'owner' : 'moderator',
        oldValue: value,
        newValue: '',
        truncated,
      })
      .catch(() => undefined);

    // Both sides need to drop it; without this the other participant keeps
    // rendering a message that no longer exists for anyone.
    withSignals(() =>
      fetch(
        `${env.SIGNALS_ENDPOINT}/groups/chat:${existing.chatId}/signals/${SignalMessages.ChatMessageDeleted}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: existing.id, chatId: existing.chatId }),
        }
      )
    ).catch(() => undefined);

    return { messageId: existing.id, chatId: existing.chatId };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

/**
 * Read the chat moderation audit (moderators only).
 *
 * A delete or a clear removes content from the product but not from the record;
 * this is the surface that makes a ChatReport reviewable afterwards. Returns
 * empty rather than throwing when ClickHouse is absent — every dev and preview
 * environment is in that state, and a mod page that errors there reads as broken
 * rather than unconfigured.
 */
export const getChatAuditHandler = async ({ input }: { input: GetChatAuditInput }) => {
  if (!clickhouse) return { items: [], nextCursor: null };

  const { chatId, actorId, type, limit, cursor } = input;

  // Every fragment below is built from zod-validated values — ints, a date, and
  // an enum — so nothing user-controlled reaches the query as a raw string.
  const conditions: string[] = [];
  if (chatId) conditions.push(`chatId = ${chatId}`);
  if (actorId) conditions.push(`actorId = ${actorId}`);
  if (type) conditions.push(`type = '${type}'`);
  if (cursor) conditions.push(`createdAt < parseDateTimeBestEffort('${cursor.toISOString()}')`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const items = await clickhouse.$query<ChatAuditEventRow>(`
    SELECT createdAt, type, chatId, messageId, actorId, subjectId, actorRole,
           oldValue, newValue, truncated
    FROM chatAuditEvents
    ${where}
    ORDER BY createdAt DESC
    LIMIT ${limit}
  `);

  return {
    items,
    nextCursor: items.length === limit ? items[items.length - 1].createdAt : null,
  };
};

/**
 * Read a whole conversation as a moderator.
 *
 * Deliberately ignores every per-user hiding rule — `deletedAt` on a message and
 * `clearedAt` on a membership — because a report filed after a participant tidied
 * their side is exactly the case this exists for. Deleted rows come back marked
 * rather than omitted, and each member's watermark is returned so the caller can
 * show what the participants themselves can no longer see.
 *
 * Reading someone's private conversation is itself recorded. Nothing else in the
 * product logs that access.
 */
export const getModeratorChatHandler = async ({
  input,
  ctx,
}: {
  input: GetModeratorChatInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { chatId, limit } = input;

    const chat = await dbRead.chat.findFirst({
      where: { id: chatId },
      select: {
        id: true,
        createdAt: true,
        chatMembers: {
          select: {
            userId: true,
            status: true,
            isOwner: true,
            clearedAt: true,
            filteredAt: true,
            user: { select: { id: true, username: true, isModerator: true } },
          },
        },
      },
    });

    if (!chat) throw throwNotFoundError(`No chat found for ID (${chatId})`);

    const messages = await dbRead.chatMessage.findMany({
      where: { chatId },
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        userId: true,
        content: true,
        contentType: true,
        deletedAt: true,
        editedAt: true,
        referenceMessageId: true,
      },
    });

    await ctx.track
      .chatAudit({
        type: 'read',
        chatId,
        actorId: ctx.user.id,
        subjectId: 0,
        actorRole: 'moderator',
        oldValue: '',
        newValue: '',
        truncated: 0,
      })
      .catch(() => undefined);

    return { chat, messages };
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
