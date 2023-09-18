import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput } from '../schema/base.schema';
import { handleTrackError, throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getImagesByEntity } from '~/server/services/image.service';
import {
  awardBountyEntry,
  deleteBountyEntry,
  getBountyEntryEarnedBuzz,
  getBountyEntryFilteredFiles,
  getEntryById,
  upsertBountyEntry,
} from '../services/bountyEntry.service';
import { BountyEntryFileMeta, UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { MetricTimeframe } from '@prisma/client';
import { getReactionsSelectV2 } from '~/server/selectors/reaction.selector';

export const getBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const entry = await getEntryById({
      input,
      select: {
        id: true,
        createdAt: true,
        bountyId: true,
        user: { select: userWithCosmeticsSelect },
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
          },
        },
      },
    });
    if (!entry) throw throwNotFoundError(`No bounty entry with id ${input.id}`);

    const images = await getImagesByEntity({ id: entry.id, type: 'BountyEntry' });
    const files = await getBountyEntryFilteredFiles({
      id: entry.id,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });

    const awardedTotal = await getBountyEntryEarnedBuzz({ ids: [entry.id] });

    return {
      ...entry,
      images: images.map((i) => ({
        ...i,
        metadata: i.metadata as ImageMetaProps,
      })),
      files,
      fileCount: files.length,
      // Returns the amount of buzz required to unlock ALL files accounting for the amount of buzz the entry has earned
      fileUnlockAmount: Math.max(
        0,
        files.reduce((acc, curr) => Math.max(acc, curr.metadata?.unlockAmount ?? 0), 0) -
          Number(awardedTotal[0]?.awardedUnitAmount ?? 0)
      ),
      awardedUnitAmountTotal: Number(awardedTotal[0]?.awardedUnitAmount ?? 0),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const upsertBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: UpsertBountyEntryInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const entry = await upsertBountyEntry({
      ...input,
      userId: ctx.user.id,
    });

    ctx.track
      .bountyEntry({
        type: input.id ? 'Create' : 'Update',
        data: {
          ...entry,
          files: input.files.map((file) => ({
            ...file.metadata,
            fileType: file.name.split('.').pop(),
          })),
        },
      })
      .catch(handleTrackError);

    return entry;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const awardBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const benefactor = await awardBountyEntry({
      ...input,
      userId: ctx.user.id,
    });

    ctx.track.bountyEntry({ type: 'Award', data: benefactor }).catch(handleTrackError);

    return benefactor;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getBountyEntryFilteredFilesHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const files = await getBountyEntryFilteredFiles({
      ...input,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });

    return files;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const deleted = await deleteBountyEntry({
      ...input,
    });
    if (!deleted) throw throwNotFoundError(`No bounty entry with id ${input.id}`);

    ctx.track.bountyEntry({ type: 'Delete', data: deleted }).catch(handleTrackError);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
