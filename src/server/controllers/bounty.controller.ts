import { isSessionOrFullUserKey } from '~/server/auth/full-user-credential';
import { TRPCError } from '@trpc/server';
import type { Context, ProtectedContext } from '../createContext';
import type { GetByIdInput } from '../schema/base.schema';
import {
  addBenefactorUnitAmount,
  deleteBountyById,
  getAllBounties,
  getBountyById,
  getBountyImages,
  getImagesForBounties,
  refundBounty,
  upsertBounty,
} from '../services/bounty.service';
import { throwAuthorizationError, throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import type {
  AddBenefactorUnitAmountInputSchema,
  BountyDetailsSchema,
  GetBountyEntriesInputSchema,
  GetInfiniteBountySchema,
  UpsertBountyInput,
} from '../schema/bounty.schema';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getAllEntriesByBountyId, getBountyEntryEarnedBuzz } from '../services/bountyEntry.service';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { getAllBenefactorsByBountyId } from '../services/bountyBenefactor.service';
import { getImagesByEntity } from '../services/image.service';
import { isDefined } from '~/utils/type-guards';
import { getFilesByEntity } from '~/server/services/file.service';
import type { BountyEntryFileMeta } from '~/server/schema/bounty-entry.schema';
import { Currency, EntityType } from '~/shared/utils/prisma/enums';
import { getLatestAppeal } from '~/server/services/report.service';
import {
  isBountyFlagAppealable,
  resolveFlagScanReasons,
} from '~/server/services/text-scan/flag-snapshot';
import { viewerReactionsSelect } from '~/server/selectors/reaction.selector';
import { handleLogError } from '~/server/utils/errorHandling';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import { publicBountyDetails } from '~/server/utils/bounty-details';
import type { NsfwLevel } from '~/server/common/enums';
import { minorMatureHidden, withoutMinorFlag } from '~/server/common/image-visibility';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import { assertBountyVisible, canViewBounty } from '~/server/services/bounty-visibility';
import { capNestedImages } from '~/server/utils/browsing-level';
import {
  bountyImageNsfwLevel,
  bountyNsfwFlagLevel,
  getTextRatedBountyLevels,
  mayBeTextRated,
} from '~/server/services/bounty-rated-level';
import { getRequestImageFilter } from '~/server/services/blocked-browsing-tags.service';

/** The held-media viewer (src/pages/api/mod/held-media): a moderator with the csamReports grant. */
const seesReportListed = (ctx: Pick<Context, 'user' | 'features'>) =>
  !!ctx.user?.isModerator && !!ctx.features?.csamReports;

/** Run after a bounty's flag raises an image's nsfwLevel: the SQL rule saw the stored level. */
const keepsMinorRule =
  (viewer: { id: number; isModerator?: boolean } | undefined) =>
  (image: { minor?: boolean | null; nsfwLevel: number; userId: number }) =>
    !minorMatureHidden(image, viewer?.id, viewer?.isModerator);

type ModerationFields = 'minor' | 'poi' | 'needsReview' | 'blockedFor' | 'ingestion';
type ModerationState = {
  userId: number;
  minor?: boolean | null;
  poi?: boolean | null;
  needsReview?: string | null;
  blockedFor?: string | null;
  ingestion?: string | null;
};
/** An image's moderation state goes only to its uploader and moderators. */
const withoutOthersModerationFields =
  (viewer: { id: number; isModerator?: boolean } | undefined) =>
  <T extends ModerationState>(image: T): Omit<T, ModerationFields> => {
    if (viewer?.isModerator || image.userId === viewer?.id) return image;
    const {
      poi: _poi,
      needsReview: _needsReview,
      blockedFor: _blockedFor,
      ingestion: _ingestion,
      ...rest
    } = image;
    return withoutMinorFlag(rest as ModerationState) as unknown as Omit<T, ModerationFields>;
  };

export const getInfiniteBountiesHandler = async ({
  input,
  ctx,
}: {
  // ids: semantic search hydrates its ranked bounties through the feed's own query.
  input: GetInfiniteBountySchema & { ids?: number[] };
  ctx: Context;
}) => {
  const { user } = ctx;
  const limit = (input.limit ?? 10) + 1;
  const userId = input.userId ?? user?.id;

  try {
    const items = await getAllBounties({
      input: { ...input, limit, userId },
      viewer: user,
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
        moderatorNsfwLevel: true,
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
    const [images, textRated, showsImage] = await Promise.all([
      getImagesForBounties({
        bountyIds: bountIds,
        userId: user?.id,
        isModerator: user?.isModerator,
        seesReportListed: seesReportListed(ctx),
      }),
      getTextRatedBountyLevels(items.filter(mayBeTextRated).map((bounty) => bounty.id)),
      getRequestImageFilter(ctx),
    ]);

    return {
      nextCursor,
      items: items
        .map(({ moderatorNsfwLevel, ...item }) => {
          const tags = item.tags;
          const user = item.user;
          const flagLevel = bountyNsfwFlagLevel(
            { ...item, moderatorNsfwLevel },
            textRated.get(item.id)
          );
          const itemImages = capNestedImages(
            (images[item.id] ?? [])
              .filter(showsImage)
              .map((image) => ({
                ...image,
                tagIds: image.tags.map((x) => x.id),
                nsfwLevel: bountyImageNsfwLevel(
                  { ...item, moderatorNsfwLevel },
                  textRated.get(item.id),
                  image.nsfwLefel
                ),
              }))
              .filter(keepsMinorRule(ctx.user))
              .map(withoutOthersModerationFields(ctx.user)),
            ctx
          );
          // if there are no images, we don't want to show the bounty
          if (!itemImages.length || !user) return null;

          return {
            ...item,
            nsfwLevel: flagLevel ?? item.nsfwLevel,
            user,
            images: itemImages,
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
        meta: true,
        moderatorNsfwLevel: true,
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
    if (
      !canViewBounty({ availability: bounty.availability, userId: bounty.user?.id ?? null }, user)
    )
      throw throwNotFoundError(`No bounty with id ${input.id}`);

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({
        userId: ctx.user?.id,
        targetUserId: bounty.user?.id,
      });
      if (blocked) throw throwNotFoundError();
    }

    const isOwner = !!user && user.id === bounty.user?.id;
    const poiFlagged = isOwner && isBountyFlagAppealable(bounty);
    const poiAppeal =
      poiFlagged && user
        ? await getLatestAppeal({
            entityType: EntityType.Bounty,
            entityId: bounty.id,
            userId: user.id,
          })
        : null;
    const { meta: _meta, moderatorNsfwLevel: _moderatorNsfwLevel, ...publicBounty } = bounty;

    const [images, textRated, showsImage] = await Promise.all([
      getBountyImages({
        id: bounty.id,
        userId: user?.id,
        isModerator: user?.isModerator,
        seesReportListed: seesReportListed(ctx),
      }),
      mayBeTextRated(bounty) ? getTextRatedBountyLevels([bounty.id]) : new Map<number, number>(),
      getRequestImageFilter(ctx),
    ]);
    const flagLevel = bountyNsfwFlagLevel(bounty, textRated.get(bounty.id));

    const files = await getFilesByEntity({ id: bounty.id, type: 'Bounty' });

    return {
      ...publicBounty,
      nsfwLevel: flagLevel ?? publicBounty.nsfwLevel,
      poiFlagged,
      poiAppeal,
      flagScanReasons: poiFlagged
        ? resolveFlagScanReasons({ isOwner, poi: bounty.poi, minor: false, meta: bounty.meta })
        : [],
      details: bounty.details
        ? publicBountyDetails(bounty.details as BountyDetailsSchema, ctx?.user?.isModerator)
        : ({} as BountyDetailsSchema),
      images: capNestedImages(
        images
          .filter(showsImage)
          .map((image) => ({
            ...image,
            nsfwLevel: bountyImageNsfwLevel(
              bounty,
              textRated.get(bounty.id),
              image.nsfwLevel
            ) as NsfwLevel,
          }))
          .filter(keepsMinorRule(ctx.user))
          .map(withoutOthersModerationFields(ctx.user)),
        ctx
      ).map((image) => ({
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
    await assertBountyVisible({ bountyId: input.id }, ctx.user);
    const limit = input.limit ?? 20;
    const blockedByUsers = (await BlockedByUsers.getCached({ userId: ctx.user?.id })).map(
      (u) => u.id
    );
    // Bound the (involuntary, unbounded) blocked-by list before it feeds the downstream
    // Prisma `notIn` in getAllEntriesByBountyId — same P2029 class as comment.getAll.
    const excludedUserIds = boundExcludedUserIds([], blockedByUsers, []);
    const entries = await getAllEntriesByBountyId({
      input: {
        bountyId: input.id,
        userId: input.owned ? ctx.user?.id : undefined,
        excludedUserIds,
        cursor: input.cursor,
        limit,
      },
      select: {
        id: true,
        createdAt: true,
        bountyId: true,
        user: { select: userWithCosmeticsSelect },
        nsfwLevel: true,
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
      sort: 'createdAt',
    });

    let nextCursor: number | undefined;
    if (entries.length > limit) {
      const nextItem = entries.pop();
      nextCursor = nextItem?.id;
    }

    const [images, showsImage] = await Promise.all([
      getImagesByEntity({
        ids: entries.map((entry) => entry.id),
        type: 'BountyEntry',
        imagesPerId: 4,
        include: ['tags'],
        isModerator: ctx.user?.isModerator,
        userId: ctx.user?.id,
        ownerSeesHeld: isSessionOrFullUserKey(ctx),
      }),
      getRequestImageFilter(ctx),
    ]);

    const files = await getFilesByEntity({
      ids: entries.map((entry) => entry.id),
      type: 'BountyEntry',
    });

    // TODO.Bounties = We should get the currency type via the main benefactor before getting the awarded amount per entry.
    const awardedTotal = await getBountyEntryEarnedBuzz({
      ids: entries.map((entry) => entry.id),
      currency: Currency.BUZZ,
    });

    return {
      nextCursor,
      items: entries
        .map((entry) => {
          const user = entry.user;
          const awardedUnitAmountTotal = Number(
            awardedTotal.find((a) => a.id === entry.id)?.awardedUnitAmount ?? 0
          );
          if (!user) return null;
          return {
            ...entry,
            user,
            images: capNestedImages(
              images.filter((i) => i.entityId === entry.id && showsImage(i)),
              ctx
            ).map((i) => ({
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
        .filter(isDefined),
    };
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
    await assertBountyVisible({ bountyId: input.id }, ctx.user);
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

export const upsertBountyHandler = async ({
  input,
  ctx,
}: {
  input: UpsertBountyInput;
  ctx: ProtectedContext;
}) => {
  try {
    const bounty = await upsertBounty({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator ?? false,
    });
    if (!bounty) throw throwNotFoundError(`No bounty with id ${input.id as number}`);

    if (input.id) ctx.track.bounty({ type: 'Update', bountyId: input.id }).catch(handleLogError);
    else ctx.track.bounty({ type: 'Create', bountyId: bounty.id }).catch(handleLogError);

    const { meta: _meta, ...publicBounty } = bounty;
    return {
      ...publicBounty,
      details: publicBounty.details
        ? publicBountyDetails(publicBounty.details as BountyDetailsSchema, ctx.user.isModerator)
        : publicBounty.details,
    };
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
  ctx: ProtectedContext;
}) => {
  try {
    const deleted = await deleteBountyById({
      ...input,
      isModerator: !!ctx.user.isModerator,
      userId: ctx.user.id,
    });

    if (!deleted) throw throwNotFoundError(`No bounty with id ${input.id}`);

    // Let it run in the background
    ctx.track.bounty({ type: 'Delete', bountyId: deleted.id }).catch(handleLogError);

    const { meta: _meta, ...publicBounty } = deleted;
    return publicBounty;
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
  ctx: ProtectedContext;
}) => {
  try {
    await assertBountyVisible({ bountyId: input.bountyId }, ctx.user);
    const { id: userId } = ctx.user;
    const bountyBenefactor = await addBenefactorUnitAmount({
      ...input,
      userId,
      buzzType: ctx.features.isGreen ? 'green' : 'yellow',
    });

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
  ctx: ProtectedContext;
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
