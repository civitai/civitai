import { Prisma } from '@prisma/client';
import { ChatMessageType } from '~/shared/utils/prisma/enums';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';

export const singleChatSelect = Prisma.validator<Prisma.ChatSelect>()({
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
    },
  },
});
