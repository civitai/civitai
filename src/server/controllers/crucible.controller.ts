import type { Context, ProtectedContext } from '~/server/createContext';
import { deriveDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
import type {
  CheckCrucibleEntryEligibilitySchema,
  CreateEntryPostSchema,
  GetCrucibleEntriesSchema,
  CancelCrucibleSchema,
  TakeDownCrucibleSchema,
  RemoveCrucibleEntrySchema,
  WithdrawCrucibleEntrySchema,
  UpdateCrucibleSchema,
  GetFeaturedCrucibleSchema,
  CreateCrucibleInputSchema,
  GetCrucibleByIdSchema,
  GetCrucibleRequiredModelsSchema,
  GetJudgingProgressSchema,
  GetJudgingStatusesSchema,
  GetCruciblesInfiniteSchema,
  GetJudgesCountSchema,
  GetJudgeStatsSchema,
  GetJudgingPairSchema,
  GetJudgingSuggestionsSchema,
  SubmitEntrySchema,
  SubmitVoteSchema,
  ToggleCrucibleFollowInput,
} from '~/server/schema/crucible.schema';
import { crucibleListSelect } from '~/server/selectors/crucible.selector';
import {
  assertCanJudgeCrucible,
  getCrucibleCreateEligibility,
  getCrucibleJudgeEligibility,
} from '~/server/services/crucible-eligibility.service';
import { toggleCrucibleFollow } from '~/server/services/crucible-engagement.service';
import { BlockedByUsers, BlockedUsers } from '~/server/services/user-preferences.service';
import { logToAxiom } from '~/server/logging/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import {
  checkCrucibleEntryEligibility,
  createCrucibleEntryPost,
  cancelCrucible,
  removeCrucibleEntry,
  withdrawCrucibleEntry,
  updateCrucible,
  createCrucible,
  getCrucibleDetail,
  getCrucibleEntries,
  getCrucibleMinVotesToPlace,
  getCrucibleRequiredModels,
  getJudgingProgress,
  getJudgingStatuses,
  getCrucibles,
  getFeaturedCrucible,
  getCrucibleJudgesCount,
  getJudgeStats,
  getJudgingPair,
  getJudgingSuggestions,
  getUserActiveCrucibles,
  getUserCrucibleStats,
  isCrucibleHiddenByScan,
  isCrucibleTakenDownForViewer,
  takeDownCrucible,
  submitEntry,
  submitVote,
  withoutEntryScores,
  withEntryCounts,
} from '~/server/services/crucible.service';

/** Creators who blocked the viewer and creators the viewer blocked; empty for moderators. */
const getBlockLists = async (user: Context['user']) => {
  if (!user || user.isModerator) return { blockedBy: [], blocked: [] };
  const [blockedBy, blocked] = await Promise.all([
    BlockedByUsers.getCached({ userId: user.id }),
    BlockedUsers.getCached({ userId: user.id }),
  ]);
  return { blockedBy: blockedBy.map((u) => u.id), blocked: blocked.map((u) => u.id) };
};

const getAllBlockedCreatorIds = async (user: Context['user']) => {
  const { blockedBy, blocked } = await getBlockLists(user);
  return [...new Set([...blockedBy, ...blocked])];
};

/** Bounded for a `notIn`; on overflow the viewer's own block list is dropped first. */
const getBlockedCreatorIds = async (user: Context['user']) => {
  const { blockedBy, blocked } = await getBlockLists(user);
  return boundExcludedUserIds([], blockedBy, blocked);
};

export const getInfiniteCruciblesHandler = async ({
  input,
  ctx,
}: {
  input: GetCruciblesInfiniteSchema;
  ctx: Context;
}) => {
  const excludedUserIds = await getBlockedCreatorIds(ctx.user);
  const { items, nextCursor } = await getCrucibles({
    input,
    select: crucibleListSelect,
    excludedUserIds,
    isModerator: ctx.user?.isModerator ?? false,
    viewerId: ctx.user?.id,
    isGreen: !!ctx.features?.isGreen,
  });
  return { items: await withEntryCounts(items), nextCursor };
};

export const getCrucibleByIdHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleByIdSchema;
  ctx: Context;
}) => {
  const crucible = await getCrucibleDetail({
    id: input.id,
    userId: ctx.user?.id,
    isModerator: !!ctx.user?.isModerator,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });
  const viewer = { viewerId: ctx.user?.id, isModerator: !!ctx.user?.isModerator };
  if (crucible && isCrucibleTakenDownForViewer(crucible, viewer)) {
    // Its owner sees why it was removed, not what was removed.
    if (crucible.userId !== viewer.viewerId) return null;
    return {
      ...crucible,
      description: null,
      image: null,
      heroImage: null,
      viewerEntries: [],
      prizeWinners: [],
    };
  }
  if (crucible && isCrucibleHiddenByScan(crucible, viewer)) return null;
  // On green a non-SFW crucible is returned so the page can point to the mature site; its adult
  // text stays off green.
  const canPreview = !!ctx.user?.isModerator || crucible?.userId === ctx.user?.id;
  if (crucible && ctx.features?.isGreen && crucible.textNsfw && !canPreview)
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
    buzzType: deriveDomainCurrency(!!ctx.features?.isGreen),
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
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
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
      blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
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
      blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
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
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });
};

export const checkEntryEligibilityHandler = async ({
  input,
  ctx,
}: {
  input: CheckCrucibleEntryEligibilitySchema;
  ctx: ProtectedContext;
}) => {
  return checkCrucibleEntryEligibility({
    ...input,
    userId: ctx.user.id,
    isModerator: ctx.user.isModerator,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });
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
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });
};

export const getJudgingPairHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgingPairSchema;
  ctx: ProtectedContext;
}) => {
  await assertCanJudgeCrucible({ userId: ctx.user.id, isModerator: ctx.user.isModerator });
  const pair = await getJudgingPair({
    ...input,
    userId: ctx.user.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: ctx.user.isModerator,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
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
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });

export const getJudgingStatusesHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgingStatusesSchema;
  ctx: ProtectedContext;
}) =>
  getJudgingStatuses({
    ...input,
    userId: ctx.user.id,
    isGreen: !!ctx.features?.isGreen,
    isModerator: ctx.user.isModerator,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });

export const submitVoteHandler = async ({
  input,
  ctx,
}: {
  input: SubmitVoteSchema;
  ctx: ProtectedContext;
}) => {
  await assertCanJudgeCrucible({ userId: ctx.user.id, isModerator: ctx.user.isModerator });
  return submitVote({
    ...input,
    userId: ctx.user.id,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
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

export const takeDownCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: TakeDownCrucibleSchema;
  ctx: ProtectedContext;
}) => {
  const result = await takeDownCrucible({ ...input, moderatorId: ctx.user.id });
  if (result.failedRefunds.length)
    logToAxiom({
      type: 'error',
      name: 'crucible-takedown-refund-failed',
      message: `Crucible ${input.id} was taken down but ${result.failedRefunds.length} refund(s) failed; take it down again to finish.`,
      crucibleId: input.id,
      userId: ctx.user.id,
      failedRefunds: result.failedRefunds,
    });
  return result;
};

export const removeCrucibleEntryHandler = ({
  input,
  ctx,
}: {
  input: RemoveCrucibleEntrySchema;
  ctx: ProtectedContext;
}) => removeCrucibleEntry({ ...input, moderatorId: ctx.user.id });

export const withdrawCrucibleEntryHandler = ({
  input,
  ctx,
}: {
  input: WithdrawCrucibleEntrySchema;
  ctx: ProtectedContext;
}) => withdrawCrucibleEntry({ ...input, userId: ctx.user.id });

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

export const getJudgeEligibilityHandler = async ({ ctx }: { ctx: ProtectedContext }) =>
  getCrucibleJudgeEligibility({ userId: ctx.user.id, isModerator: ctx.user.isModerator });

export const getUserCrucibleStatsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserCrucibleStats({ userId: ctx.user.id });
};

export const getUserActiveCruciblesHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserActiveCrucibles({
    userId: ctx.user.id,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
    site: { isGreen: !!ctx.features?.isGreen, isModerator: !!ctx.user.isModerator },
  });
};

export const getFeaturedCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: GetFeaturedCrucibleSchema;
  ctx: Context;
}) => {
  const excludedUserIds = await getBlockedCreatorIds(ctx.user);
  return getFeaturedCrucible({
    excludedUserIds,
    browsingLevel: input.browsingLevel,
    isGreen: !!ctx.features?.isGreen,
    isLoggedIn: !!ctx.user,
  });
};

export const getJudgesCountHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgesCountSchema;
  ctx: Context;
}) => {
  const count = await getCrucibleJudgesCount({
    crucibleId: input.crucibleId,
    viewer: {
      isModerator: !!ctx.user?.isModerator,
      blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
    },
  });

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
  const excludedUserIds = await getBlockedCreatorIds(ctx.user);
  return getJudgingSuggestions({
    ...input,
    userId: ctx.user.id,
    excludedUserIds,
    isGreen: !!ctx.features?.isGreen,
  });
};

export const toggleCrucibleFollowHandler = async ({
  input,
  ctx,
}: {
  input: ToggleCrucibleFollowInput;
  ctx: ProtectedContext;
}) =>
  toggleCrucibleFollow({
    ...input,
    userId: ctx.user.id,
    isModerator: ctx.user.isModerator,
    blockedCreatorIds: await getAllBlockedCreatorIds(ctx.user),
  });
