import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput } from '../schema/base.schema';
import {
  createBounty,
  deleteBountyById,
  getAllBounties,
  getBountyById,
  getBountyImages,
  getImagesForBounties,
  updateBountyById,
} from '../services/bounty.service';
import { throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import {
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
} from '../schema/bounty.schema';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getAllEntriesByBountyId } from '../services/bountyEntry.service';
import { getAllBenefactorsByBountyId } from '../services/bountyBenefactor.service';
import { getImagesByEntity } from '../services/image.service';

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
      items: items.map((item) => ({ ...item, images: images[item.id] })),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getBountyHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const bounty = await getBountyById({ ...input, select: getBountyDetailsSelect });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

    const images = await getImagesByEntity({ id: bounty.id, type: 'Bounty' });

    return { ...bounty, images };
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
    const entries = await getAllEntriesByBountyId({
      input: { bountyId: input.id },
      select: { id: true, user: { select: userWithCosmeticsSelect } },
    });

    return entries;
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
      select: { buzzAmount: true, user: { select: userWithCosmeticsSelect } },
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
