import { TRPCError } from '@trpc/server';
import { throwDbError } from '~/server/utils/errorHandling';
import {
  ClubPostResourceInput,
  ClubResourceInput,
  GetInfiniteClubPostsSchema,
  SupportedClubEntities,
  SupportedClubPostEntities,
  UpsertClubPostInput,
} from '~/server/schema/club.schema';
import { Context } from '~/server/createContext';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';
import {
  deleteClubPost,
  getAllClubPosts,
  getClubPostById,
  getClubPostResourceData,
  getResourceDetailsForClubPostCreation,
  upsertClubPost,
} from '~/server/services/clubPost.service';
import { GetByIdInput } from '~/server/schema/base.schema';
import { MetricTimeframe } from '@prisma/client';
import { dbRead } from '../db/client';
import { getReactionsSelectV2 } from '../selectors/reaction.selector';
import { isDefined } from '../../utils/type-guards';

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
        entityId: true,
        entityType: true,
        metrics: {
          select: {
            likeCount: true,
            dislikeCount: true,
            laughCount: true,
            cryCount: true,
            heartCount: true,
          },
          where: {
            timeframe: MetricTimeframe.AllTime,
          },
        },
        reactions: {
          select: getReactionsSelectV2,
        },
      },
    });

    const entities = items
      .filter((x) => x.entityId && x.entityType)
      .map((x) => ({
        entityId: x.entityId as number,
        entityType: x.entityType as SupportedClubPostEntities,
      }));

    const entityData = await getClubPostResourceData({
      clubPosts: entities,
      user,
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items: items
        .map(({ metrics, coverImage, ...x }) => {
          const resource =
            x.entityType && x.entityId
              ? entityData.find((d) => d.entityId === x.entityId && d.entityType === x.entityType)
              : undefined;

          return {
            ...x,
            metrics: metrics[0] ?? {
              likeCount: 0,
              dislikeCount: 0,
              laughCount: 0,
              cryCount: 0,
              heartCount: 0,
            },
            entityType: x.entityType as SupportedClubPostEntities | null,
            ...resource,
            coverImage: coverImage
              ? {
                  ...coverImage,
                  metadata: coverImage.metadata as MixedObject,
                  meta: coverImage.meta as ImageMetaProps,
                  tags: coverImage.tags.map((t) => t.tag),
                }
              : null,
          };
        })
        .filter((x) => (x.entityType && x.entityId ? 'data' in x && isDefined(x.data) : true)),
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
        entityId: true,
        entityType: true,
      },
    });

    const { coverImage } = post;

    const [entityData] =
      post.entityId && post.entityType
        ? await getClubPostResourceData({
            clubPosts: [
              { entityId: post.entityId, entityType: post.entityType as SupportedClubPostEntities },
            ],
            user,
          })
        : [undefined];

    return {
      ...post,
      entityType: post.entityType as SupportedClubPostEntities | null,
      ...entityData,
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

export const getResourceDetailsForClubPostCreationHandler = async ({
  input,
  ctx,
}: {
  input: ClubPostResourceInput;
  ctx: Context;
}) => {
  const { user } = ctx;

  try {
    const [data] = await getResourceDetailsForClubPostCreation({
      entities: [input],
      user,
    });

    return data;
  } catch (error) {
    throw throwDbError(error);
  }
};
