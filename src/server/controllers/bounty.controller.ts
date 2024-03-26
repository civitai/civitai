import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput } from '../schema/base.schema';
import {
  addBenefactorUnitAmount,
  createBounty,
  deleteBountyById,
  getAllBounties,
  getBountyById,
  getBountyFiles,
  getBountyImages,
  getImagesForBounties,
  refundBounty,
  updateBountyById,
  upsertBounty,
} from '../services/bounty.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '../utils/errorHandling';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import {
  AddBenefactorUnitAmountInputSchema,
  BountyDetailsSchema,
  CreateBountyInput,
  GetBountyEntriesInputSchema,
  GetInfiniteBountySchema,
  UpdateBountyInput,
  UpsertBountyInput,
} from '../schema/bounty.schema';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getAllEntriesByBountyId, getBountyEntryEarnedBuzz } from '../services/bountyEntry.service';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getAllBenefactorsByBountyId } from '../services/bountyBenefactor.service';
import { getImagesByEntity } from '../services/image.service';
import { isDefined } from '~/utils/type-guards';
import { getFilesByEntity } from '~/server/services/file.service';
import { BountyEntryFileMeta } from '~/server/schema/bounty-entry.schema';
import { Currency } from '@prisma/client';
import { getReactionsSelectV2 } from '~/server/selectors/reaction.selector';
import { handleLogError } from '~/server/utils/errorHandling';
import { NsfwLevel } from '~/server/common/enums';

export const getInfiniteBountiesHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteBountySchema;
  ctx: Context;
}) => {
  const { user } = ctx;
  const limit = input.limit + 1 ?? 10;
  const userId = input.userId ?? user?.id;

  try {
    const items = await getAllBounties({
      input: { ...input, limit, userId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        expiresAt: true,
        type: true,
        complete: true,
        user: { select: userWithCosmeticsSelect },
        nsfw: true,
        nsfwLevel: true,
        tags: {
          select: {
            tagId: true,
            // tag: {
            //   select: { id: true, name: true },
            // },
          },
        },
        stats: {
          select: {
            favoriteCountAllTime: true,
            trackCountAllTime: true,
            entryCountAllTime: true,
            benefactorCountAllTime: true,
            unitAmountCountAllTime: true,
            commentCountAllTime: true,
          },
        },
      },
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    const bountIds = items.map((bounty) => bounty.id);
    const images = await getImagesForBounties({
      bountyIds: bountIds,
      userId: user?.id,
      isModerator: user?.isModerator,
    });

    return {
      nextCursor,
      items: items
        .map((item) => {
          const itemImages = images[item.id];
          const tags = item.tags;
          const user = item.user;
          // if there are no images, we don't want to show the bounty
          if (!itemImages?.length || !user) return null;

          return {
            ...item,
            nsfwLevel: item.nsfw ? NsfwLevel.XXX : item.nsfwLevel,
            user,
            images: itemImages.map((image) => ({
              ...image,
              tagIds: image.tags.map((x) => x.id),
              // !important - for feed queries, when `bounty.nsfw === true`, we set all image `nsfwLevel` values to `NsfwLevel.XXX`
              nsfwLevel: item.nsfw ? NsfwLevel.XXX : image.nsfwLefel,
            })),
            tags: tags.map(({ tagId }) => tagId),
          };
        })
        .filter(isDefined),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getBountyHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const { user } = ctx;
    const bounty = await getBountyById({
      ...input,
      select: {
        ...getBountyDetailsSelect,
        benefactors: {
          select: {
            user: {
              select: userWithCosmeticsSelect,
            },
            awardedToId: true,
            unitAmount: true,
            currency: true,
          },
        },
      },
    });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

    const images = await getBountyImages({
      id: bounty.id,
      userId: user?.id,
      isModerator: user?.isModerator,
    });

    const files = await getFilesByEntity({ id: bounty.id, type: 'Bounty' });

    return {
      ...bounty,
      details: bounty.details as BountyDetailsSchema,
      images: images.map((image) => ({
        ...image,
        meta: (image?.meta ?? {}) as ImageMetaProps,
        metadata: image?.metadata as MixedObject,
      })),
      tags: bounty.tags.map(({ tag }) => tag),
      files,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getBountyEntriesHandler = async ({
  input,
  ctx,
}: {
  input: GetBountyEntriesInputSchema;
  ctx: Context;
}) => {
  try {
    const entries = await getAllEntriesByBountyId({
      input: { bountyId: input.id, userId: input.owned ? ctx.user?.id : undefined },
      select: {
        id: true,
        createdAt: true,
        bountyId: true,
        user: { select: userWithCosmeticsSelect },
        nsfwLevel: true,
        reactions: {
          select: getReactionsSelectV2,
        },

        stats: {
          select: {
            likeCountAllTime: true,
            dislikeCountAllTime: true,
            heartCountAllTime: true,
            laughCountAllTime: true,
            cryCountAllTime: true,
            unitAmountCountAllTime: true,
            tippedAmountCountAllTime: true,
          },
        },
      },
      sort: 'benefactorCount',
    });

    const images = await getImagesByEntity({
      ids: entries.map((entry) => entry.id),
      type: 'BountyEntry',
      imagesPerId: 4,
      include: ['tags'],
      isModerator: ctx.user?.isModerator,
      userId: ctx.user?.id,
    });

    const files = await getFilesByEntity({
      ids: entries.map((entry) => entry.id),
      type: 'BountyEntry',
    });

    // TODO.Bounties = We should get the currency type via the main benefactor before getting the awarded amount per entry.
    const awardedTotal = await getBountyEntryEarnedBuzz({
      ids: entries.map((entry) => entry.id),
      currency: Currency.BUZZ,
    });

    return entries
      .map((entry) => {
        const user = entry.user;
        const awardedUnitAmountTotal = Number(
          awardedTotal.find((a) => a.id === entry.id)?.awardedUnitAmount ?? 0
        );
        if (!user) return null;
        return {
          ...entry,
          user,
          images: images
            .filter((i) => i.entityId === entry.id)
            .map((i) => ({
              ...i,
              tagIds: i.tags?.map((x) => x.id),
              metadata: i.metadata as ImageMetaProps,
            })),
          // Returns the amount of buzz required to unlock ALL files accounting for the amount of buzz the entry has earned
          fileUnlockAmount: Math.max(
            0,
            files.reduce(
              (acc, curr) =>
                Math.max(
                  acc,
                  curr.metadata ? (curr.metadata as BountyEntryFileMeta)?.unlockAmount ?? 0 : 0
                ),
              0
            ) - awardedUnitAmountTotal
          ),
          fileCount: files.length,

          awardedUnitAmountTotal,
        };
      })
      .filter(isDefined);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getBountyBenefactorsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const benefactors = await getAllBenefactorsByBountyId({
      input: { bountyId: input.id },
      select: { unitAmount: true, user: { select: userWithCosmeticsSelect } },
    });

    return benefactors;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const createBountyHandler = async ({
  input,
  ctx,
}: {
  input: CreateBountyInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { nsfw, poi } = input;

    if (nsfw && poi)
      throw throwBadRequestError('Mature content depicting actual people is not permitted.');

    const bounty = await createBounty({ ...input, userId });

    // Let it run in the background
    ctx.track.bounty({ type: 'Create', bountyId: bounty.id }).catch(handleLogError);

    return bounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const updateBountyHandler = async ({
  input,
  ctx,
}: {
  input: UpdateBountyInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const updated = await updateBountyById({
      ...input,
      userId: ctx.user.id,
    });
    if (!updated) throw throwNotFoundError(`No bounty with id ${input.id}`);

    // Let it run in the background
    ctx.track.bounty({ type: 'Update', bountyId: updated.id }).catch(handleLogError);

    return updated;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const upsertBountyHandler = async ({
  input,
  ctx,
}: {
  input: UpsertBountyInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const bounty = await upsertBounty({ ...input, userId: ctx.user.id });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

    if (input.id) ctx.track.bounty({ type: 'Update', bountyId: input.id }).catch(handleLogError);
    else ctx.track.bounty({ type: 'Create', bountyId: bounty.id }).catch(handleLogError);

    return bounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteBountyHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const deleted = await deleteBountyById({
      ...input,
      isModerator: !!ctx.user.isModerator,
    });

    if (!deleted) throw throwNotFoundError(`No bounty with id ${input.id}`);

    // Let it run in the background
    ctx.track.bounty({ type: 'Delete', bountyId: deleted.id }).catch(handleLogError);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const addBenefactorUnitAmountHandler = async ({
  input,
  ctx,
}: {
  input: AddBenefactorUnitAmountInputSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const bountyBenefactor = await addBenefactorUnitAmount({ ...input, userId });

    ctx.track
      .bountyBenefactor({
        type: 'Create',
        bountyId: bountyBenefactor.bountyId,
        userId: bountyBenefactor.userId,
      })
      .catch(handleLogError);

    return bountyBenefactor;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const refundBountyHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId, isModerator } = ctx.user;

    if (!isModerator) {
      throw throwAuthorizationError();
    }

    const refundedBounty = await refundBounty({ ...input, isModerator });

    return refundedBounty;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
