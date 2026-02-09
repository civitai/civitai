import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import type {
  CreateStrikeInput,
  GetStrikesInput,
  GetMyStrikesInput,
  VoidStrikeInput,
} from '~/server/schema/strike.schema';
import {
  createStrike,
  getStrikesForMod,
  getStrikesForUser,
  voidStrike,
} from '~/server/services/strike.service';
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

export const getUserStrikeHistoryHandler = async ({ input }: { input: { userId: number } }) => {
  try {
    return await getStrikesForUser(input.userId, {
      includeExpired: true,
      includeInternalNotes: true, // Mod-only endpoint
    });
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
    const { strikes, totalActivePoints, nextExpiry } = await getStrikesForUser(ctx.user.id, {
      includeInternalNotes: false,
    });
    return {
      activeStrikes: strikes.filter((s) => s.status === 'Active').length,
      totalActivePoints,
      nextExpiry,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
