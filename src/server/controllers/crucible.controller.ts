import type { Context, ProtectedContext } from '~/server/createContext';
import type {
  CheckCrucibleEntryEligibilitySchema,
  CreateEntryPostSchema,
  GetCrucibleEntriesSchema,
  CancelCrucibleSchema,
  UpdateCrucibleSchema,
  CreateCrucibleInputSchema,
  GetCrucibleByIdSchema,
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
import { amIBlockedByUser } from '~/server/services/user.service';
import { boundExcludedUserIds } from '~/server/utils/excluded-user-ids';
import {
  checkCrucibleEntryEligibility,
  createCrucibleEntryPost,
  cancelCrucible,
  updateCrucible,
  createCrucible,
  getCrucibleDetail,
  getCrucibleEntries,
  getCrucibles,
  getFeaturedCrucible,
  getJudgesCount,
  getJudgeStats,
  getJudgingPair,
  getJudgingSuggestions,
  getUserActiveCrucibles,
  getUserCrucibleStats,
  submitEntry,
  submitVote,
  withoutEntryScores,
} from '~/server/services/crucible.service';

const getBlockedByUserIds = async (user: Context['user']) => {
  if (!user || user.isModerator) return [];
  const blockedByUsers = (await BlockedByUsers.getCached({ userId: user.id })).map((u) => u.id);
  return boundExcludedUserIds([], blockedByUsers, []);
};

export const getInfiniteCruciblesHandler = async ({
  input,
  ctx,
}: {
  input: GetCruciblesInfiniteSchema;
  ctx: Context;
}) => {
  const excludedUserIds = await getBlockedByUserIds(ctx.user);
  return getCrucibles({
    input,
    select: crucibleListSelect,
    excludedUserIds,
    isModerator: ctx.user?.isModerator ?? false,
  });
};

export const getCrucibleByIdHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleByIdSchema;
  ctx: Context;
}) => {
  const crucible = await getCrucibleDetail({ id: input.id, userId: ctx.user?.id });
  if (crucible && ctx.user && !ctx.user.isModerator) {
    const blocked = await amIBlockedByUser({
      userId: ctx.user.id,
      targetUserId: crucible.userId,
    });
    if (blocked) return null;
  }
  return crucible;
};

export const createCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: CreateCrucibleInputSchema;
  ctx: ProtectedContext;
}) => {
  return createCrucible({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator });
};

export const getCrucibleEntriesHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleEntriesSchema;
  ctx: Context;
}) => {
  return getCrucibleEntries({ ...input, userId: ctx.user?.id });
};

export const createEntryPostHandler = async ({
  input,
  ctx,
}: {
  input: CreateEntryPostSchema;
  ctx: ProtectedContext;
}) => {
  return createCrucibleEntryPost({ ...input, userId: ctx.user.id });
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
  return submitEntry({ ...input, userId: ctx.user.id });
};

export const getJudgingPairHandler = async ({
  input,
  ctx,
}: {
  input: GetJudgingPairSchema;
  ctx: ProtectedContext;
}) => {
  const pair = await getJudgingPair({ ...input, userId: ctx.user.id });

  return withoutEntryScores(pair);
};

export const submitVoteHandler = async ({
  input,
  ctx,
}: {
  input: SubmitVoteSchema;
  ctx: ProtectedContext;
}) => {
  return submitVote({ ...input, userId: ctx.user.id });
};

export const cancelCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: CancelCrucibleSchema;
  ctx: ProtectedContext;
}) => {
  return cancelCrucible({ ...input, userId: ctx.user.id, isModerator: !!ctx.user.isModerator });
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

export const getFeaturedCrucibleHandler = async ({ ctx }: { ctx: Context }) => {
  const excludedUserIds = await getBlockedByUserIds(ctx.user);
  return getFeaturedCrucible({ excludedUserIds });
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
  return getJudgingSuggestions({ ...input, userId: ctx.user.id, excludedUserIds });
};
