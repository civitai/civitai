import { TRPCError } from '@trpc/server';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  GetClubTiersInput,
  GetInfiniteClubSchema,
  GetPaginatedClubResourcesSchema,
  RemoveClubResourceInput,
  supportedClubEntities,
  SupportedClubEntities,
  UpdateClubResourceInput,
  UpsertClubInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  deleteClub,
  deleteClubTier,
  getAllClubs,
  getClub,
  getClubDetailsForResource,
  getClubTiers,
  getPaginatedClubResources,
  removeClubResource,
  updateClubResource,
  upsertClub,
  upsertClubResource,
  upsertClubTier,
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
import { MetricTimeframe } from '@prisma/client';

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
    await upsertClubTier({
      clubId: clubId as number,
      tier,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function deleteClubTierHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    await deleteClubTier({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function userContributingClubsHandler({
  ctx,
}: {
  ctx: Context;
}): ReturnType<typeof userContributingClubs> {
  try {
    if (!ctx.user) return [];
    return userContributingClubs({ userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
    return [];
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
      entityType: input.entityType,
      entityIds: [input.entityId],
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
      entityType: input.entityType as SupportedClubEntities,
      entityIds: input.entityId,
    });

    return details;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export const getInfiniteClubsHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteClubSchema;
  ctx: Context;
}) => {
  const { user } = ctx;
  const limit = input.limit + 1 ?? 10;
  const userId = input.userId ?? user?.id;
  const { include } = input;

  try {
    const items = await getAllClubs({
      input: { ...input, limit, userId },
      select: {
        id: true,
        name: true,
        user: {
          select: userWithCosmeticsSelect,
        },
        coverImage: {
          select: imageSelect,
        },
        nsfw: true,
        metrics: {
          select: {
            memberCount: true,
            resourceCount: true,
            clubPostCount: true,
          },
          where: {
            timeframe: MetricTimeframe.AllTime,
          },
        },
        tiers: include?.includes('tiers')
          ? {
              select: {
                id: true,
                name: true,
              },
            }
          : undefined,
      },
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      items: items
        .map(({ metrics, coverImage, ...item }) => {
          return {
            ...item,
            stats: metrics[0] ?? {
              memberCount: 0,
              resourceCount: 0,
              clubPostCount: 0,
            },
            coverImage: coverImage
              ? {
                  ...coverImage,
                  meta: coverImage.meta as ImageMetaProps,
                  metadata: coverImage.metadata as MixedObject,
                  tags: coverImage.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
                }
              : coverImage,
          };
        })
        .filter(isDefined),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};
export const getPaginatedClubResourcesHandler = async ({
  input,
  ctx,
}: {
  input: GetPaginatedClubResourcesSchema;
  ctx: Context;
}) => {
  const { user } = ctx;
  try {
    return getPaginatedClubResources(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function updateClubResourceHandler({
  input,
  ctx,
}: {
  input: UpdateClubResourceInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    await updateClubResource({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });

    const [details] = await getClubDetailsForResource({
      entityType: input.entityType,
      entityIds: [input.entityId],
    });

    return details;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function removeClubResourceHandler({
  input,
  ctx,
}: {
  input: RemoveClubResourceInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return removeClubResource({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function deleteClubHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return deleteClub({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
