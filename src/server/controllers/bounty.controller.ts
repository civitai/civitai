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
  updateBountyById,
} from '../services/bounty.service';
import { throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import {
  AddBenefactorUnitAmountInputSchema,
  BountyDetailsSchema,
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
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

export const getInfiniteBountiesHandler = async ({
  input,
  ctx,
}: {
  input: GetInfiniteBountySchema;
  ctx: Context;
}) => {
  const limit = input.limit + 1 ?? 10;

  try {
    const items = await getAllBounties({
      input: { ...input, limit },
      select: {
        id: true,
        name: true,
        createdAt: true,
        expiresAt: true,
        type: true,
        user: { select: userWithCosmeticsSelect },
      },
    });

    let nextCursor: number | undefined;
    if (items.length > input.limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    const bountIds = items.map((bounty) => bounty.id);
    const images = await getImagesForBounties({ bountyIds: bountIds });

    return {
      nextCursor,
      items: items
        .map((item) => {
          const itemImages = images[item.id];
          // if there are no images, we don't want to show the bounty
          if (!itemImages?.length) return null;

          return { ...item, images: itemImages };
        })
        .filter(isDefined),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getBountyHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
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

    const images = await getBountyImages({ id: bounty.id });
    const files = await getFilesByEntity({ id: bounty.id, type: 'Bounty' });

    return {
      ...bounty,
      details: bounty.details as BountyDetailsSchema,
      images: images.map((image) => ({
        ...image,
        meta: image?.meta as ImageMetaProps | null,
      })),
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
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    // TODO.Bounties = We should get the currency type via the main benefactor before getting the awarded amount per entry.
    const entries = await getAllEntriesByBountyId({
      input: { bountyId: input.id },
      select: {
        id: true,
        createdAt: true,
        bountyId: true,
        user: { select: userWithCosmeticsSelect },
      },
    });

    const images = await getImagesByEntity({
      ids: entries.map((entry) => entry.id),
      type: 'BountyEntry',
      imagesPerId: 4,
    });

    const files = await getFilesByEntity({
      ids: entries.map((entry) => entry.id),
      type: 'BountyEntry',
    });

    const awardedTotal = await getBountyEntryEarnedBuzz({
      ids: entries.map((entry) => entry.id),
      currency: Currency.BUZZ,
    });

    return entries.map((entry) => ({
      ...entry,
      images: images
        .filter((i) => i.entityId === entry.id)
        .map((i) => ({
          ...i,
          metadata: i.metadata as ImageMetaProps,
        })),
      fileCount: files.length,
      awardedUnitAmountTotal: Number(
        awardedTotal.find((a) => a.id === entry.id)?.awardedUnitAmount ?? 0
      ),
    }));
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
    const bounty = await createBounty({ ...input, userId });

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
    const updated = await updateBountyById(input);
    if (!updated) throw throwNotFoundError(`No bounty with id ${input.id}`);

    return updated;
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
    const deleted = await deleteBountyById(input);
    if (!deleted) throw throwNotFoundError(`No bounty with id ${input.id}`);

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
    return bountyBenefactor;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
