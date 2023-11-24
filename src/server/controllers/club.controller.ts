import { TRPCError } from '@trpc/server';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  GetClubEntityInput,
  GetClubTiersInput,
  UpsertClubInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getClub,
  getClubEntity,
  getClubTiers,
  upsertClub,
  upsertClubTiers,
  userContributingClubs,
} from '~/server/services/club.service';
import { GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';

export async function getClubHandler({ input, ctx }: { input: GetByIdInput; ctx: Context }) {
  try {
    return await getClub({
      ...input,
      userId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function upsertClubHandler({
  input,
  ctx,
}: {
  input: UpsertClubInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return await upsertClub({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function getClubTiersHandler({
  input,
  ctx,
}: {
  input: GetClubTiersInput;
  ctx: Context;
}) {
  try {
    const tiers = await getClubTiers({
      ...input,
      userId: ctx?.user?.id,
      isModerator: !!ctx?.user?.isModerator,
    });

    return tiers ?? [];
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
    // Makes typescript happy :sweatsmile:...
    return [];
  }
}

export async function upsertClubTierHandler({
  input,
  ctx,
}: {
  input: UpsertClubTierInput;
  ctx: DeepNonNullable<Context>;
}) {
  const { clubId, ...tier } = input;
  try {
    await upsertClubTiers({
      clubId: clubId as number,
      tiers: [tier],
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
      deleteTierIds: [],
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function userContributingClubsHandler({ ctx }: { ctx: Context }) {
  try {
    if (!ctx.user) return [];

    return userContributingClubs({ userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function getClubEntityHandler({
  input,
  ctx,
}: {
  input: GetClubEntityInput;
  ctx: Context;
}) {
  try {
    return await getClubEntity({
      ...input,
      userId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
