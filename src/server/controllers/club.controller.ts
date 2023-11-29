import { TRPCError } from '@trpc/server';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  GetClubTiersInput,
  GetInfiniteClubPostsSchema,
  supportedClubEntities,
  SupportedClubEntities,
  UpsertClubInput,
  UpsertClubPostInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getAllClubPosts,
  getClub,
  getClubDetailsForResource,
  getClubTiers,
  upsertClub,
  upsertClubPost,
  upsertClubResource,
  upsertClubTiers,
  userContributingClubs,
} from '~/server/services/club.service';
import { GetByEntityInput, GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';
import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { getAllBounties, getImagesForBounties } from '~/server/services/bounty.service';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { isDefined } from '~/utils/type-guards';
import { imageSelect } from '~/server/selectors/image.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';

export async function getClubHandler({ input, ctx }: { input: GetByIdInput; ctx: Context }) {
  try {
    return await getClub({
      ...input,
      userId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function upsertClubHandler({
  input,
  ctx,
}: {
  input: UpsertClubInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return await upsertClub({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function getClubTiersHandler({
  input,
  ctx,
}: {
  input: GetClubTiersInput;
  ctx: Context;
}) {
  try {
    const tiers = await getClubTiers({
      ...input,
      userId: ctx?.user?.id,
      isModerator: !!ctx?.user?.isModerator,
    });

    return tiers ?? [];
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
    // Makes typescript happy :sweatsmile:...
    return [];
  }
}

export async function upsertClubTierHandler({
  input,
  ctx,
}: {
  input: UpsertClubTierInput;
  ctx: DeepNonNullable<Context>;
}) {
  const { clubId, ...tier } = input;
  try {
    await upsertClubTiers({
      clubId: clubId as number,
      tiers: [tier],
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
      deleteTierIds: [],
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function userContributingClubsHandler({ ctx }: { ctx: Context }) {
  try {
    if (!ctx.user) return [];

    return userContributingClubs({ userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function upsertClubResourceHandler({
  input,
  ctx,
}: {
  input: UpsertClubResourceInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    await upsertClubResource({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });

    const [details] = await getClubDetailsForResource({
      entities: [
        {
          entityType: input.entityType,
          entityId: input.entityId,
        },
      ],
    });

    return details;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function getClubResourceDetailsHandler({ input }: { input: GetByEntityInput }) {
  try {
    if (!supportedClubEntities.some((e) => (e as string) === input.entityType)) {
      throw throwBadRequestError(`Unsupported entity type: ${input.entityType}`);
    }

    const [details] = await getClubDetailsForResource({
      entities: [
        {
          entityType: input.entityType as SupportedClubEntities,
          entityId: input.entityId,
        },
      ],
    });

    return details;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

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
