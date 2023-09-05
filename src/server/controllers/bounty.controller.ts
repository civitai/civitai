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
  updateBountyById,
} from '../services/bounty.service';
import { throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import {
  AddBenefactorUnitAmountInputSchema,
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
} from '../schema/bounty.schema';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getAllEntriesByBountyId } from '../services/bountyEntry.service';
import { ImageMetaProps } from '~/server/schema/image.schema';

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

    return { nextCursor, items };
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
            unitAmount: true,
            currency: true,
          },
        },
      },
    });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id}`);

    const images = await getBountyImages({ id: bounty.id });
    const files = await getBountyFiles({ id: bounty.id });

    return {
      ...bounty,
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
