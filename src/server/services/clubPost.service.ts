import { ClubMembershipRole, Prisma } from '@prisma/client';
import { GetInfiniteClubPostsSchema, UpsertClubPostInput } from '~/server/schema/club.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { createEntityImages } from '~/server/services/image.service';
import { getClub, userContributingClubs } from '~/server/services/club.service';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getAllClubPosts = async <TSelect extends Prisma.ClubPostSelect>({
  input: { cursor, limit: take, clubId, isModerator, userId },
  select,
}: {
  input: GetInfiniteClubPostsSchema & {
    userId?: number;
    isModerator?: boolean;
  };
  select: TSelect;
}) => {
  const clubWithMembership = userId
    ? await dbRead.club.findUniqueOrThrow({
        where: { id: clubId },
        select: {
          userId: true,
          memberships: {
            where: {
              userId,
            },
          },
        },
      })
    : undefined;

  const includeMembersOnlyContent =
    isModerator ||
    (clubWithMembership &&
      (userId === clubWithMembership.userId || clubWithMembership.memberships.length > 0))
      ? undefined
      : false;

  return dbRead.clubPost.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
    where: {
      clubId,
      membersOnly: includeMembersOnlyContent,
    },
  });
};

export const getClubPostById = async <TSelect extends Prisma.ClubPostSelect>({
  input: { id, isModerator, userId },
  select,
}: {
  input: GetByIdInput & {
    userId?: number;
    isModerator?: boolean;
  };
  select: TSelect;
}) => {
  // Need to query the basics first to confirm the user has some right to access this post.
  const post = await dbRead.clubPost.findUniqueOrThrow({
    select: {
      clubId: true,
      membersOnly: true,
    },
    where: {
      id,
    },
  });

  const clubWithMembership = userId
    ? await dbRead.club.findUniqueOrThrow({
        where: { id: post.clubId },
        select: {
          userId: true,
          memberships: {
            where: {
              userId,
            },
          },
        },
      })
    : undefined;

  const includeMembersOnlyContent =
    isModerator ||
    (clubWithMembership &&
      (userId === clubWithMembership.userId || clubWithMembership.memberships.length > 0))
      ? undefined
      : false;

  if (post.membersOnly && !includeMembersOnlyContent) {
    throw throwAuthorizationError('You do not have permission to view this post.');
  }

  return dbRead.clubPost.findUniqueOrThrow({
    select,
    where: {
      id,
    },
  });
};

export const upsertClubPost = async ({
  coverImage,
  userId,
  isModerator,
  ...input
}: UpsertClubPostInput & {
  userId: number;
  isModerator?: boolean;
}) => {
  const dbClient = dbWrite;
  const club = await getClub({ id: input.clubId as number, userId });

  const [userClub] = await userContributingClubs({ userId, clubIds: [input.clubId as number] });
  const isOwner = userClub.userId === userId;

  if (!userClub && !isModerator) {
    throw throwAuthorizationError('You do not have permission to create posts on this club.');
  }

  if (input.id) {
    const post = await dbClient.clubPost.findUniqueOrThrow({
      where: {
        id: input.id,
      },
      select: {
        id: true,
        createdById: true,
      },
    });

    if (
      post.createdById !== userId &&
      !isModerator &&
      !isOwner &&
      userClub.memberships.find((m) => m.role === ClubMembershipRole.Admin)
    ) {
      throw throwAuthorizationError('You do not have permission to edit this post.');
    }
  }

  const [createdCoverImage] =
    coverImage && !coverImage.id
      ? await createEntityImages({
          userId: userClub.userId, // Belongs to the club owner basically.
          images: [coverImage],
        })
      : [];

  if (input.id) {
    const post = await dbClient.clubPost.update({
      where: {
        id: input.id,
      },
      data: {
        ...input,
        coverImageId:
          coverImage === null
            ? null
            : coverImage === undefined
            ? undefined
            : coverImage?.id ?? createdCoverImage?.id,
      },
    });

    return post;
  } else {
    const post = await dbClient.clubPost.create({
      data: {
        ...input,
        createdById: userId,
        coverImageId: coverImage?.id ?? createdCoverImage?.id,
      },
    });

    return post;
  }
};
