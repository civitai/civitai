import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput } from '../schema/base.schema';
import {
  handleLogError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '../utils/errorHandling';
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
import { UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getReactionsSelectV2 } from '~/server/selectors/reaction.selector';
import { getBountyById } from '../services/bounty.service';
import { bountiesSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

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
        description: true,
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
            tippedAmountCountAllTime: true,
          },
        },
      },
    });
    if (!entry) throw throwNotFoundError(`No bounty entry with id ${input.id}`);

    const images = await getImagesByEntity({
      id: entry.id,
      type: 'BountyEntry',
      isModerator: ctx.user?.isModerator,
      userId: ctx.user?.id,
      imagesPerId: 10,
    });
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
        meta: i.meta as ImageMetaProps,
        metadata: i.metadata as MixedObject,
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
  const { id: userId } = ctx.user;
  try {
    const bounty = await getBountyById({
      id: input.bountyId,
      select: { complete: true, entryLimit: true, entries: { select: { userId: true } } },
    });
    if (!bounty) throw throwNotFoundError('Bounty not found');
    if (bounty.complete) throw throwBadRequestError('Bounty is already complete');

    // if the current user has more entries than allowed, throw an error
    if (
      !input.id &&
      bounty.entryLimit &&
      bounty.entries.filter((entry) => entry.userId === userId).length >= bounty.entryLimit
    ) {
      throw throwBadRequestError('You have reached the maximum number of entries for this bounty');
    }

    const entry = await upsertBountyEntry({
      ...input,
      userId,
    });

    if (!entry) throw throwNotFoundError(`No bounty entry with id ${input.id}`);

    ctx.track
      .bountyEntry({ type: input.id ? 'Create' : 'Update', bountyEntryId: entry.id })
      .catch(handleLogError);

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

    if (benefactor.awardedToId)
      ctx.track
        .bountyEntry({
          type: 'Award',
          bountyEntryId: benefactor.awardedToId,
          benefactorId: benefactor.userId,
        })
        .catch(handleLogError);

    await bountiesSearchIndex.queueUpdate([
      { id: benefactor.bountyId, action: SearchIndexUpdateQueueAction.Update },
    ]);

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
      isModerator: !!ctx.user.isModerator,
    });
    if (!deleted) throw throwNotFoundError(`No bounty entry with id ${input.id}`);

    ctx.track.bountyEntry({ type: 'Delete', bountyEntryId: deleted.id }).catch(handleLogError);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
