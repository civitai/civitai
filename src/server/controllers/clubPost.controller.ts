import { TRPCError } from '@trpc/server';
import { throwDbError } from '~/server/utils/errorHandling';
import { GetInfiniteClubPostsSchema, UpsertClubPostInput } from '~/server/schema/club.schema';
import { Context } from '~/server/createContext';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';
import {
  deleteClubPost,
  getAllClubPosts,
  getClubPostById,
  upsertClubPost,
} from '~/server/services/clubPost.service';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getInfiniteClubPostsHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteClubPostsSchema;
  ctx: Context;
}) => {
  const { user } = ctx;
  const limit = input.limit + 1 ?? 10;

  try {
    const items = await getAllClubPosts({
      input: { ...input, limit, userId: user?.id, isModerator: user?.isModerator },
      select: {
        id: true,
        createdBy: {
          select: userWithCosmeticsSelect,
        },
        coverImage: {
          select: imageSelect,
        },
        title: true,
        description: true,
        createdAt: true,
        clubId: true,
        membersOnly: true,
      },
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items: items.map(({ coverImage, ...x }) => ({
        ...x,
        coverImage: coverImage
          ? {
              ...coverImage,
              metadata: coverImage.metadata as MixedObject,
              meta: coverImage.meta as ImageMetaProps,
              tags: coverImage.tags.map((t) => t.tag),
            }
          : null,
      })),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getClubPostByIdHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  const { user } = ctx;

  try {
    const post = await getClubPostById({
      input: {
        id: input.id,
        userId: user?.id,
        isModerator: user?.isModerator,
      },
      select: {
        id: true,
        createdBy: {
          select: userWithCosmeticsSelect,
        },
        coverImage: {
          select: imageSelect,
        },
        title: true,
        description: true,
        createdAt: true,
        clubId: true,
        membersOnly: true,
      },
    });

    const { coverImage } = post;

    return {
      ...post,
      coverImage: coverImage
        ? {
            ...coverImage,
            metadata: coverImage.metadata as MixedObject,
            meta: coverImage.meta as ImageMetaProps,
            tags: coverImage.tags.map((t) => t.tag),
          }
        : null,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function upsertClubPostHandler({
  input,
  ctx,
}: {
  input: UpsertClubPostInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    await upsertClubPost({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function deleteClubPostHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    await deleteClubPost({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
