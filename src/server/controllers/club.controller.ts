import { TRPCError } from '@trpc/server';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  GetClubTiersInput,
  UpsertClubInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getClub,
  getClubDetailsForResource,
  getClubTiers,
  upsertClub,
  upsertClubResource,
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

export async function upsertClubResourceHandler({
  input,
  ctx,
}: {
  input: UpsertClubResourceInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    await upsertClubResource({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });

    const [details] = await getClubDetailsForResource({
      entities: [
        {
          entityType: input.entityType,
          entityId: input.entityId,
        },
      ],
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });

    return details;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
