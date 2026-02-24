import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import type {
  CreateStrikeInput,
  GetStrikesInput,
  GetMyStrikesInput,
  GetUserStandingsInput,
  VoidStrikeInput,
} from '~/server/schema/strike.schema';
import {
  createStrike,
  getStrikeHistoryForMod,
  getStrikesForMod,
  getStrikesForUser,
  getStrikeSummary,
  getUserStandings,
  voidStrike,
} from '~/server/services/strike.service';
import { userMeta as userMetaSchema } from '~/server/schema/user.schema';
import { throwDbError } from '~/server/utils/errorHandling';

export const createStrikeHandler = async ({
  input,
  ctx,
}: {
  input: CreateStrikeInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await createStrike({ ...input, issuedBy: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const voidStrikeHandler = async ({
  input,
  ctx,
}: {
  input: VoidStrikeInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await voidStrike({ ...input, voidedBy: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getStrikesHandler = async ({ input }: { input: GetStrikesInput }) => {
  try {
    return await getStrikesForMod(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getUserStandingsHandler = async ({ input }: { input: GetUserStandingsInput }) => {
  try {
    return await getUserStandings(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getUserStrikeHistoryHandler = async ({ input }: { input: { userId: number } }) => {
  try {
    const { user: rawUser, ...strikeData } = await getStrikeHistoryForMod(input.userId);

    const parsed = userMetaSchema.safeParse(rawUser?.meta);
    const meta = parsed.success ? parsed.data : {};

    return {
      ...strikeData,
      user: rawUser
        ? {
            id: rawUser.id,
            username: rawUser.username,
            createdAt: rawUser.createdAt,
            muted: rawUser.muted,
            bannedAt: rawUser.bannedAt,
            deletedAt: rawUser.deletedAt,
            scores: meta.scores ?? null,
            flaggedForReview: meta.strikeFlaggedForReview ?? false,
          }
        : null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getMyStrikesHandler = async ({
  input,
  ctx,
}: {
  input: GetMyStrikesInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await getStrikesForUser(ctx.user.id, {
      includeExpired: input.includeExpired,
      includeInternalNotes: false, // Never expose internal notes to users
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getMyStrikeSummaryHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    return await getStrikeSummary(ctx.user.id);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
