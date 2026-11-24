import { isSessionOrFullUserKey } from '~/server/auth/full-user-credential';
import { TRPCError } from '@trpc/server';
import type { Context, ProtectedContext } from '../createContext';
import type { GetByIdInput } from '../schema/base.schema';
import {
  handleLogError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '../utils/errorHandling';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getImagesByEntity } from '~/server/services/image.service';
import { capNestedImages } from '~/server/utils/browsing-level';
import { getRequestImageFilter } from '~/server/services/blocked-browsing-tags.service';
import {
  awardBountyEntry,
  deleteBountyEntry,
  getBountyEntryEarnedBuzz,
  getBountyEntryFilteredFiles,
  getEntryById,
  upsertBountyEntry,
  BOUNTY_ENTRY_LIMIT_REACHED,
} from '../services/bountyEntry.service';
import type {
  SubmitBountyEntryInput,
  UpsertBountyEntryInput,
} from '~/server/schema/bounty-entry.schema';
import { Currency, MediaType } from '~/shared/utils/prisma/enums';
import { viewerReactionsSelect } from '~/server/selectors/reaction.selector';
import { getBountyById } from '../services/bounty.service';
import { bountiesSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import { amIBlockedByUser } from '~/server/services/user.service';
import { assertBountyStarted } from '~/server/services/bounty-schedule';
import { assertBountyVisible } from '~/server/services/bounty-visibility';

export const getBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    await assertBountyVisible({ entryId: input.id }, ctx.user);
    const entry = await getEntryById({
      input,
      select: {
        id: true,
        description: true,
        createdAt: true,
        bountyId: true,
        user: { select: userWithCosmeticsSelect },
        reactions: viewerReactionsSelect(ctx.user?.id),
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

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({ userId: ctx.user.id, targetUserId: entry.user?.id });
      if (blocked) throw throwNotFoundError();
    }

    const canEdit = !!ctx.user && (ctx.user.isModerator || ctx.user.id === entry.user?.id);
    const [images, showsImage] = await Promise.all([
      getImagesByEntity({
        id: entry.id,
        type: 'BountyEntry',
        include: ['tags'],
        isModerator: ctx.user?.isModerator,
        userId: ctx.user?.id,
        ownerSeesHeld: isSessionOrFullUserKey(ctx),
        imagesPerId: canEdit ? constants.bounties.maxEntryImagesForEdit : 10,
      }),
      getRequestImageFilter(ctx),
    ]);
    const files = await getBountyEntryFilteredFiles({
      id: entry.id,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });

    const awardedTotal = await getBountyEntryEarnedBuzz({ ids: [entry.id] });

    return {
      ...entry,
      images: capNestedImages(images.filter(showsImage), ctx).map((i) => ({
        ...i,
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
  replaceImages,
}: {
  input: UpsertBountyEntryInput;
  ctx: ProtectedContext;
  /** See `upsertBountyEntry`. */
  replaceImages?: boolean;
}) => {
  const { id: userId } = ctx.user;
  try {
    await assertBountyVisible({ bountyId: input.bountyId }, ctx.user);
    const bounty = await getBountyById({
      id: input.bountyId,
      select: {
        userId: true,
        complete: true,
        startsAt: true,
        entryLimit: true,
        entries: { select: { userId: true } },
      },
    });
    if (!bounty) throw throwNotFoundError('Bounty not found');
    if (bounty.complete) throw throwBadRequestError('Bounty is already complete');
    if (!input.id) assertBountyStarted(bounty);
    if (!input.id && bounty.userId === userId)
      throw throwBadRequestError('You cannot submit entries to your own bounty.');

    // if the current user has more entries than allowed, throw an error
    if (
      !input.id &&
      bounty.entryLimit &&
      bounty.entries.filter((entry) => entry.userId === userId).length >= bounty.entryLimit
    ) {
      throw throwBadRequestError(BOUNTY_ENTRY_LIMIT_REACHED);
    }

    const entry = await upsertBountyEntry({
      ...input,
      userId,
      replaceImages,
    });

    if (!entry) throw throwNotFoundError(`No bounty entry with id ${input.id as number}`);

    ctx.track
      .bountyEntry({ type: input.id ? 'Create' : 'Update', bountyEntryId: entry.id })
      .catch(handleLogError);

    return entry;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Headless/agent (MCP) friendly bounty-entry submission. Assembles the full
 * `upsert` input shape from minimal, already-uploaded refs and delegates to the
 * existing upsertBountyEntryHandler so all validation, buzz/award checks, and
 * tracking run through the same path. Kept on guardedProcedure like upsert; no
 * buzz is spent on submission, so it does NOT need blockApiKeys.
 */
export const submitBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: SubmitBountyEntryInput;
  ctx: ProtectedContext;
}) => {
  const { files, imageUuids, ...rest } = input;

  const upsertInput: UpsertBountyEntryInput = {
    ...rest,
    files: files.map((f) => ({
      id: f.id,
      url: f.url,
      name: f.name,
      sizeKB: f.sizeKB,
      metadata: {
        unlockAmount: f.unlockAmount ?? 0,
        currency: f.currency ?? Currency.BUZZ,
        benefactorsOnly: f.benefactorsOnly ?? false,
      },
    })),
    images: imageUuids.map((url) => ({ url, type: MediaType.image })),
  };

  // Sends the entry's whole image set and never reads the stored one, so an edit replaces it.
  return upsertBountyEntryHandler({ input: upsertInput, ctx, replaceImages: true });
};

export const awardBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
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
    await assertBountyVisible({ entryId: input.id }, ctx.user);
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
  ctx: ProtectedContext;
}) => {
  try {
    const deleted = await deleteBountyEntry({
      ...input,
      userId: ctx.user.id,
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
