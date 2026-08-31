import { Prisma } from '@prisma/client';
import { ChatMessageType } from '~/shared/utils/prisma/enums';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';

export const singleChatSelect = Prisma.validator<Prisma.ChatSelect>()({
  id: true,
  createdAt: true,
  hash: true,
  ownerId: true,
  isGroup: true,
  name: true,
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
      filteredAt: true,
      notifyLevel: true,
      pinnedAt: true,
      clearedAt: true,
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
});

/**
 * The quoted message carried alongside a reply. `chatId` and `deletedAt` ride
 * along so the read path can drop a reference that does not belong to the chat
 * being read, or that has since been deleted — a stored `referenceMessageId` is
 * only as trustworthy as the check that was in force when it was written.
 */
export const chatReferenceMessageSelect = Prisma.validator<Prisma.ChatMessageSelect>()({
  id: true,
  userId: true,
  content: true,
  contentType: true,
  chatId: true,
  deletedAt: true,
  createdAt: true,
});

export const latestChat = Prisma.validator<Prisma.ChatSelect>()({
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
      deletedAt: null,
    },
  },
});
