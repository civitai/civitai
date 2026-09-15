import type { Context, ProtectedContext } from '~/server/createContext';
import type {
  CancelCrucibleSchema,
  CreateCrucibleInputSchema,
  GetCrucibleByIdSchema,
  GetCruciblesInfiniteSchema,
  GetJudgesCountSchema,
  GetJudgeStatsSchema,
  GetJudgingPairSchema,
  SubmitEntrySchema,
  SubmitVoteSchema,
} from '~/server/schema/crucible.schema';
import { crucibleListSelect } from '~/server/selectors/crucible.selector';
import {
  cancelCrucible,
  createCrucible,
  getCrucibleDetail,
  getCrucibles,
  getFeaturedCrucible,
  getJudgesCount,
  getJudgeStats,
  getJudgingPair,
  getUserActiveCrucibles,
  getUserCrucibleStats,
  submitEntry,
  submitVote,
  withoutEntryScores,
} from '~/server/services/crucible.service';

export const getInfiniteCruciblesHandler = async ({
  input,
}: {
  input: GetCruciblesInfiniteSchema;
}) => {
  const items = await getCrucibles({ input, select: crucibleListSelect });

  return {
    items,
    nextCursor: items.length > 0 ? items[items.length - 1].id : undefined,
  };
};

export const getCrucibleByIdHandler = async ({
  input,
  ctx,
}: {
  input: GetCrucibleByIdSchema;
  ctx: Context;
}) => {
  return getCrucibleDetail({ id: input.id, userId: ctx.user?.id });
};

export const createCrucibleHandler = async ({
  input,
  ctx,
}: {
  input: CreateCrucibleInputSchema;
  ctx: ProtectedContext;
}) => {
  return createCrucible({ ...input, userId: ctx.user.id });
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
  // isModerator runs as router middleware, so reaching here means the caller is one.
  return cancelCrucible({ ...input, userId: ctx.user.id, isModerator: true });
};

export const getUserCrucibleStatsHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserCrucibleStats({ userId: ctx.user.id });
};

export const getUserActiveCruciblesHandler = async ({ ctx }: { ctx: ProtectedContext }) => {
  return getUserActiveCrucibles({ userId: ctx.user.id });
};

export const getFeaturedCrucibleHandler = async () => {
  return getFeaturedCrucible();
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
