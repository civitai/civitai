import type { Context, ProtectedContext } from '~/server/createContext';
import { deriveDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
import type {
  CheckCrucibleEntryEligibilitySchema,
  CreateEntryPostSchema,
  GetCrucibleEntriesSchema,
  CancelCrucibleSchema,
  UpdateCrucibleSchema,
  GetFeaturedCrucibleSchema,
  CreateCrucibleInputSchema,
  GetCrucibleByIdSchema,
  GetCrucibleRequiredModelsSchema,
  GetJudgingProgressSchema,
  GetCruciblesInfiniteSchema,
  GetJudgesCountSchema,
  GetJudgeStatsSchema,
  GetJudgingPairSchema,
  GetJudgingSuggestionsSchema,
  SubmitEntrySchema,
  SubmitVoteSchema,
} from '~/server/schema/crucible.schema';
import { crucibleListSelect } from '~/server/selectors/crucible.selector';
import { getCrucibleCreateEligibility } from '~/server/services/crucible-eligibility.service';
import { BlockedByUsers } from '~/server/services/user-preferences.service';
import { logToAxiom } from '~/server/logging/client';
import { amIBlockedByUser } from '~/server/services/user.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import {
  checkCrucibleEntryEligibility,
  createCrucibleEntryPost,
  cancelCrucible,
  updateCrucible,
  createCrucible,
  getCrucibleDetail,
  getCrucibleEntries,
  getCrucibleMinVotesToPlace,
  getCrucibleRequiredModels,
  getJudgingProgress,
  getCrucibles,
  getFeaturedCrucible,
  getJudgesCount,
  getJudgeStats,
  getJudgingPair,
  getJudgingSuggestions,
  getUserActiveCrucibles,
  getUserCrucibleStats,
  isCrucibleHiddenByScan,
  submitEntry,
  submitVote,
  withoutEntryScores,
  withPaidEntryCount,
} from '~/server/services/crucible.service';

const getAllBlockedByUserIds = async (user: Context['user']) => {
  if (!user || user.isModerator) return [];
  return (await BlockedByUsers.getCached({ userId: user.id })).map((u) => u.id);
};

const getBlockedByUserIds = async (user: Context['user']) =>
  boundExcludedUserIds([], await getAllBlockedByUserIds(user), []);

export const getInfiniteCruciblesHandler = async ({
  input,
  ctx,
}: {
  input: GetCruciblesInfiniteSchema;
  ctx: Context;
}) => {
  const excludedUserIds = await getBlockedByUserIds(ctx.user);
  const { items, nextCursor } = await getCrucibles({
    input,
    select: crucibleListSelect,
    excludedUserIds,
    isModerator: ctx.user?.isModerator ?? false,
    viewerId: ctx.user?.id,
    isGreen: !!ctx.features?.isGreen,
  });
  return { items: await withPaidEntryCount(items), nextCursor };
};

export const getCrucibleByIdHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleByIdSchema;
  ctx: Context;
}) => {
  const crucible = await getCrucibleDetail({ id: input.id, userId: ctx.user?.id });
  const viewer = { viewerId: ctx.user?.id, isModerator: !!ctx.user?.isModerator };
  if (crucible && isCrucibleHiddenByScan(crucible, viewer)) return null;
  if (crucible && ctx.user && !ctx.user.isModerator) {
    const blocked = await amIBlockedByUser({
      userId: ctx.user.id,
      targetUserId: crucible.userId,
    });
    if (blocked) return null;
  }
  // Off the green site a green crucible doesn't exist, as for user challenges; on green a yellow one
  // is returned so the page can show the redirect to the mature site.
  const canPreview = !!ctx.user?.isModerator || crucible?.userId === ctx.user?.id;
  if (crucible && !ctx.features?.isGreen && crucible.buzzType === 'green' && !canPreview)
    return null;
  // Returned on green only so the page can point to the mature site; its adult text stays off green.
  if (
    crucible &&
    ctx.features?.isGreen &&
    crucible.buzzType !== 'green' &&
    crucible.textNsfw &&
    !canPreview
  )
    return { ...crucible, name: 'Crucible', description: null };
  // A background image that hasn't passed its scan falls back to the cover for everyone else.
  if (
    crucible?.heroImage &&
    crucible.heroImage.ingestion !== ImageIngestionStatus.Scanned &&
    !canPreview
  )
    return { ...crucible, heroImage: null };
  return crucible;
};

export const createCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: CreateCrucibleInputSchema;
  ctx: ProtectedContext;
}) => {
  return createCrucible({
    ...input,
    userId: ctx.user.id,
    isModerator: ctx.user.isModerator,
    buzzType: input.buzzType ?? deriveDomainCurrency(!!ctx.features?.isGreen),
  });
};

export const getCrucibleEntriesHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleEntriesSchema;
  ctx: Context;
}) => {
  return getCrucibleEntries({
    ...input,
    userId: ctx.user?.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: !!ctx.user?.isModerator,
    blockedByUserIds: await getAllBlockedByUserIds(ctx.user),
  });
};

export const getRequiredModelsHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleRequiredModelsSchema;
  ctx: Context;
}) =>
  getCrucibleRequiredModels({
    crucibleId: input.id,
    browsingLevel: input.browsingLevel,
    viewer: {
      viewerId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
      isGreen: !!ctx.features?.isGreen,
    },
  });

export const getMinVotesToPlaceHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleByIdSchema;
  ctx: ProtectedContext;
}) =>
  getCrucibleMinVotesToPlace({
    crucibleId: input.id,
    viewer: {
      viewerId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
      isGreen: !!ctx.features?.isGreen,
    },
  });

export const createEntryPostHandler = async ({
  input,
  ctx,
}: {
  input: CreateEntryPostSchema;
  ctx: ProtectedContext;
}) => {
  return createCrucibleEntryPost({
    ...input,
    userId: ctx.user.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: ctx.user.isModerator,
    blockedByUserIds: await getAllBlockedByUserIds(ctx.user),
  });
};

export const checkEntryEligibilityHandler = async ({
  input,
  ctx,
}: {
  input: CheckCrucibleEntryEligibilitySchema;
  ctx: ProtectedContext;
}) => {
  return checkCrucibleEntryEligibility({ ...input, userId: ctx.user.id });
};

export const submitEntryHandler = async ({
  input,
  ctx,
}: {
  input: SubmitEntrySchema;
  ctx: ProtectedContext;
}) => {
  return submitEntry({
    ...input,
    userId: ctx.user.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: ctx.user.isModerator,
    blockedByUserIds: await getAllBlockedByUserIds(ctx.user),
  });
};

export const getJudgingPairHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgingPairSchema;
  ctx: ProtectedContext;
}) => {
  const pair = await getJudgingPair({
    ...input,
    userId: ctx.user.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: ctx.user.isModerator,
    blockedByUserIds: await getAllBlockedByUserIds(ctx.user),
  });

  return withoutEntryScores(pair);
};

export const getJudgingProgressHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgingProgressSchema;
  ctx: ProtectedContext;
}) =>
  getJudgingProgress({
    ...input,
    userId: ctx.user.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: ctx.user.isModerator,
    blockedByUserIds: await getAllBlockedByUserIds(ctx.user),
  });

export const submitVoteHandler = async ({
  input,
  ctx,
}: {
  input: SubmitVoteSchema;
  ctx: ProtectedContext;
}) => {
  return submitVote({
    ...input,
    userId: ctx.user.id,
    blockedByUserIds: await getAllBlockedByUserIds(ctx.user),
  });
};

export const cancelCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: CancelCrucibleSchema;
  ctx: ProtectedContext;
}) => {
  const result = await cancelCrucible({
    ...input,
    userId: ctx.user.id,
    isModerator: !!ctx.user.isModerator,
  });
  if (result.failedRefunds.length)
    logToAxiom({
      type: 'error',
      name: 'crucible-cancel-refund-failed',
      message: `Crucible ${input.id} was cancelled but ${result.failedRefunds.length} refund(s) failed; cancel it again to finish.`,
      crucibleId: input.id,
      userId: ctx.user.id,
      failedRefunds: result.failedRefunds,
    });
  return result;
};

export const updateCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: UpdateCrucibleSchema;
  ctx: ProtectedContext;
}) => {
  return updateCrucible({ ...input, userId: ctx.user.id, isModerator: !!ctx.user.isModerator });
};

export const getCreateEligibilityHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getCrucibleCreateEligibility(ctx.user.id);
};

export const getUserCrucibleStatsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserCrucibleStats({ userId: ctx.user.id });
};

export const getUserActiveCruciblesHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserActiveCrucibles({ userId: ctx.user.id });
};

export const getFeaturedCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: GetFeaturedCrucibleSchema;
  ctx: Context;
}) => {
  const excludedUserIds = await getBlockedByUserIds(ctx.user);
  return getFeaturedCrucible({
    excludedUserIds,
    browsingLevel: input.browsingLevel,
    isGreen: !!ctx.features?.isGreen,
    isLoggedIn: !!ctx.user,
  });
};

export const getJudgesCountHandler = async ({ input }: { input: GetJudgesCountSchema }) => {
  const count = await getJudgesCount(input.crucibleId);

  return { count };
};

export const getJudgeStatsHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgeStatsSchema;
  ctx: ProtectedContext;
}) => {
  return getJudgeStats({ userId: ctx.user.id, crucibleId: input.crucibleId });
};

export const getJudgingSuggestionsHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgingSuggestionsSchema;
  ctx: ProtectedContext;
}) => {
  const excludedUserIds = await getBlockedByUserIds(ctx.user);
  return getJudgingSuggestions({
    ...input,
    userId: ctx.user.id,
    excludedUserIds,
    isGreen: !!ctx.features?.isGreen,
  });
};
