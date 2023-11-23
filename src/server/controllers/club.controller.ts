import { TRPCError } from '@trpc/server';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  GetClubTiersInput,
  UpsertClubInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import { getClub, getClubTiers, upsertClub, upsertClubTiers } from '~/server/services/club.service';
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
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return await getClubTiers({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
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
